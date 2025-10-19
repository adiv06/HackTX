import sounddevice as sd
import numpy as np
from scipy.io.wavfile import write
import keyboard
import time
from queue import Queue
from threading import Thread
import json
from pathlib import Path
from deepgram import DeepgramClient
from getpass import getpass

import google.generativeai as genai

import requests

# ---------- Recording settings ----------
SAMPLE_RATE = 48000
MATCH_NAME = "HyperX QuadCast S"
CHANNELS = 1
CHUNK_DURATION = 30  # seconds per transcription chunk

audio_buffer = []
is_recording = False

# Queue for audio chunks to be processed
chunk_queue = Queue()

# JSON storage
mindmap_json = {
    "nodes": [],
    "edges": []
}

# ---------- Deepgram setup ----------
DG_KEY = getpass("Deepgram SECRET: ").strip()
dg = DeepgramClient(api_key=DG_KEY)

# ---------- Device detection ----------
def find_hyperx_device(prefer_api="WASAPI"):
    devices = sd.query_devices()
    matches = [(i, d) for i, d in enumerate(devices)
               if MATCH_NAME.lower() in d['name'].lower() and d['max_input_channels'] > 0]
    if not matches:
        return None
    for i, d in matches:
        host = sd.query_hostapis()[d['hostapi']]['name']
        if prefer_api.lower() in host.lower():
            return i, d
    return matches[0]

# ---------- Recording callback ----------
def audio_callback(indata, frames, time_info, status):
    global audio_buffer, is_recording
    if status:
        print("⚠️", status)
    if is_recording:
        audio_buffer.append(indata.copy())

def normalize_audio(audio):
    max_val = np.max(np.abs(audio))
    if max_val == 0:
        return audio
    return audio * (0.95 / max_val)

def first_transcript(resp):
    """Extract transcript from Deepgram response object"""
    # Safe navigation helper
    def nav(cur, *path):
        for k in path:
            if cur is None:
                return None
            if isinstance(k, int):
                try:
                    cur = cur[k]
                except Exception:
                    return None
            else:
                if hasattr(cur, k):
                    cur = getattr(cur, k)
                elif isinstance(cur, dict):
                    cur = cur.get(k)
                else:
                    return None
        return cur
    
    # Try typed path
    t = nav(resp, "results", "channels", 0, "alternatives", 0, "transcript")
    if t: return t
    
    # Try dict-ish path
    chs = nav(resp, "results", "channels") or []
    if chs:
        alts = chs[0].get("alternatives", [])
        if alts and "transcript" in alts[0]:
            return alts[0]["transcript"]
    return ""


# ---------- Deepgram transcription ----------
def transcribe_audio_file(file_path):
    """Transcribe audio file using Deepgram SDK 5.x"""
    try:
        with open(file_path, "rb") as f:
            buffer_data = f.read()
        
        # Use the same pattern that works in your notebook
        # Catch validation errors and parse raw JSON instead
        try:
            response = dg.listen.v1.media.transcribe_file(
                request=buffer_data,
                model="nova-3",
                language="en",
                smart_format=True,
                diarize=False,  # Disable diarization to avoid speaker_confidence validation errors
                utterances=False  # Disable utterances to avoid validation errors
            )
        except Exception as validation_error:
            # If Pydantic validation fails, try to extract from the raw response
            print(f"⚠️ Validation warning (still getting transcript): {str(validation_error)[:100]}")
            # The error usually happens after the API call succeeds, so we can still get data
            # Try alternative: just get the basic transcript without diarization
            response = dg.listen.v1.media.transcribe_file(
                request=buffer_data,
                model="nova-3",
                language="en",
                smart_format=True
            )
        
        return first_transcript(response)
        
    except Exception as e:
        print(f"⚠️ Deepgram transcription error: {e}")
        return ""

# ---------- Gemini setup ----------
GEMINI_KEY = getpass("Gemini API key: ").strip()
genai.configure(api_key=GEMINI_KEY)

def process_with_gemini(transcript, current_json):
    prompt = f"""You are a mind-mapping AI assistant. Based on the transcript below, extract key concepts and their relationships.

Current mind map state:
{json.dumps(current_json)}

New transcript:
"{transcript}"

Extract main concepts from this transcript and create nodes with relationships. Each node should represent a distinct concept, action, or entity mentioned.

Respond with ONLY a raw JSON object (no markdown, no code blocks, no explanations). Use this exact structure:
{{
  "nodes": [{{"id": "unique_id", "label": "Concept Name"}}],
  "edges": [{{"from": "source_id", "to": "target_id"}}]
}}"""

    model = genai.GenerativeModel(model_name="gemini-2.0-flash-exp")
    response = model.generate_content([prompt])

    try:
        text = response.candidates[0].content.parts[0].text.strip()
        print("🔍 Raw Gemini output:", text[:200])  # debug (truncated)
        
        # Remove markdown code blocks if present
        if text.startswith("```"):
            # Find the actual JSON content between code blocks
            lines = text.split('\n')
            json_lines = []
            in_code_block = False
            for line in lines:
                if line.strip().startswith("```"):
                    in_code_block = not in_code_block
                    continue
                if in_code_block or (not line.strip().startswith("```")):
                    json_lines.append(line)
            text = '\n'.join(json_lines).strip()
        
        data = json.loads(text)
        
        # Ensure it has proper keys
        if "nodes" not in data or "edges" not in data:
            print("⚠️ Gemini output missing 'nodes' or 'edges'. Keeping old JSON.")
            return None
        return data
    except Exception as e:
        print(f"⚠️ Invalid Gemini response: {e}. Keeping old JSON.")
        print(f"   Attempted to parse: {text[:100]}...")
        return None


# ---------- Gemini processing worker ----------
def gemini_worker():
    global mindmap_json
    while True:
        chunk_data = chunk_queue.get()
        if chunk_data is None:
            break  # stop worker

        chunk_file, chunk_transcript = chunk_data
        print(f"🤖 Sending transcript to Gemini for processing...")

        new_json = process_with_gemini(chunk_transcript, mindmap_json)

        if new_json:
            # Merge nodes and edges only if valid JSON returned
            mindmap_json["nodes"].extend(new_json.get("nodes", []))
            mindmap_json["edges"].extend(new_json.get("edges", []))

            # Save updated JSON
            out_path = Path("mindmap.json")
            out_path.write_text(json.dumps(mindmap_json, indent=2), encoding="utf-8")
            print(f"✅ mindmap.json updated with Gemini insights from {chunk_file}")

            # Post to Lambda
            post_json_to_lambda(mindmap_json)
        else:
            print(f"⚠️ No valid Gemini JSON for {chunk_file}. Old data preserved.")

        chunk_queue.task_done()

LAMBDA_ENDPOINT = "https://YOUR_LAMBDA_ENDPOINT_HERE"

def post_json_to_lambda(data):
    try:
        response = requests.post(LAMBDA_ENDPOINT, json=data, timeout=10)
        if response.status_code == 200:
            print("✅ Successfully posted mindmap JSON to Lambda.")
        else:
            print(f"⚠️ Lambda returned status {response.status_code}: {response.text}")
    except Exception as e:
        print(f"⚠️ Failed to post JSON to Lambda: {e}")

# ---------- Main ----------
def main():
    global audio_buffer, is_recording, CHANNELS

    # Device
    found = find_hyperx_device()
    if found is None:
        print(f"❌ Could not find a device named '{MATCH_NAME}'.")
        return
    device_index, device_info = found
    CHANNELS = device_info['max_input_channels']
    hostapi_name = sd.query_hostapis()[device_info['hostapi']]['name']
    print(f"🎯 Using device index {device_index}: {device_info['name']} (Host API: {hostapi_name})")
    print(f"📝 Detected channels: {CHANNELS}")
    print("Instructions: press 'r' to start recording, press 's' to stop and save.")

    # Start Gemini worker thread
    worker_thread = Thread(target=gemini_worker, daemon=True)
    worker_thread.start()

    chunk_count = 0
    chunk_start_time = None

    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                            callback=audio_callback, device=device_index):
            while True:
                # Start recording
                if keyboard.is_pressed('r') and not is_recording:
                    audio_buffer = []
                    is_recording = True
                    chunk_start_time = time.time()
                    print("🔴 Recording started...")
                    time.sleep(0.3)

                # Stop recording
                if keyboard.is_pressed('s') and is_recording:
                    is_recording = False
                    print("🛑 Recording stopped.")
                    time.sleep(0.3)
                    break

                # Check if a chunk is ready
                if is_recording and audio_buffer:
                    elapsed = time.time() - chunk_start_time
                    if elapsed >= CHUNK_DURATION:
                        chunk_count += 1
                        # Process chunk
                        chunk_audio = np.concatenate(audio_buffer, axis=0)
                        if CHANNELS == 1:
                            chunk_audio = chunk_audio.flatten()
                        chunk_audio = normalize_audio(chunk_audio)
                        chunk_int16 = np.int16(np.clip(chunk_audio, -1, 1) * 32767)

                        # Save temp WAV
                        temp_file = f"chunk_{chunk_count}.wav"
                        write(temp_file, SAMPLE_RATE, chunk_int16)

                        # Transcribe
                        transcript = transcribe_audio_file(temp_file)
                        print(f"\n🎤 Transcript for chunk {chunk_count}: {transcript}")

                        # Send to Gemini via queue
                        chunk_queue.put((temp_file, transcript))

                        # Reset buffer and timer
                        audio_buffer = []
                        chunk_start_time = time.time()

        # Process final audio
        if audio_buffer:
            chunk_count += 1
            final_audio = np.concatenate(audio_buffer, axis=0)
            if CHANNELS == 1:
                final_audio = final_audio.flatten()
            final_audio = normalize_audio(final_audio)
            final_int16 = np.int16(np.clip(final_audio, -1, 1) * 32767)
            final_file = f"chunk_{chunk_count}.wav"
            write(final_file, SAMPLE_RATE, final_int16)
            transcript = transcribe_audio_file(final_file)
            print(f"\n🎤 Transcript for final chunk: {transcript}")
            chunk_queue.put((final_file, transcript))

    except Exception as e:
        print("❌ Error:", e)

    # Stop worker thread
    chunk_queue.put(None)
    worker_thread.join()
    print("✅ All chunks processed. Final mindmap.json saved.")

if __name__ == "__main__":
    main()