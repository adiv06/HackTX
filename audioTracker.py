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
BLOCKSIZE = 1024     # increase if you still see overflows

audio_buffer = []
is_recording = False

chunk_queue = Queue()
mindmap_json = {"nodes": [], "edges": []}

# ---------- Deepgram setup ----------
DG_KEY = getpass("Deepgram SECRET: ").strip()
dg = DeepgramClient(api_key=DG_KEY)

# ---------- Device detection ----------
def find_hyperx_device(prefer_api="WASAPI"):
    devices = sd.query_devices()
    # Look for the HyperX QuadCast first
    matches = [(i, d) for i, d in enumerate(devices)
               if MATCH_NAME.lower() in d['name'].lower() and d['max_input_channels'] > 0]
    if matches:
        # Prefer the host API you like
        for i, d in matches:
            host = sd.query_hostapis()[d['hostapi']]['name']
            if prefer_api.lower() in host.lower():
                return i, d
        return matches[0]

    # Fallback to default input device (lower sampling rate for fallback devices)
    try:
        # lower sample rate for fallback devices to reduce CPU / overflow risk
        global SAMPLE_RATE
        SAMPLE_RATE = 20000
        default_index = sd.default.device[0]  # default input device index
        default_info = sd.query_devices(default_index)
        print(f"⚠️ Could not find '{MATCH_NAME}'. Falling back to default input: {default_info['name']}")
        return default_index, default_info
    except Exception as e:
        print(f"❌ No suitable input device found: {e}")
        return None


# ---------- Recording callback ----------
def audio_callback(indata, frames, time_info, status):
    # Suppress frequent Input overflow messages but keep other status prints
    global audio_buffer, is_recording
    if status:
        # prefer attribute check if available
        if getattr(status, "input_overflow", False):
            # silently ignore this to avoid console spam
            pass
        else:
            print("⚠️ Audio callback status:", status)
    if is_recording:
        # store a copy to avoid reference issues
        audio_buffer.append(indata.copy())


def normalize_audio(audio):
    max_val = np.max(np.abs(audio))
    if max_val == 0:
        return audio
    return audio * (0.95 / max_val)


def first_transcript(resp):
    """Extract transcript from Deepgram response object safely"""
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

    t = nav(resp, "results", "channels", 0, "alternatives", 0, "transcript")
    if t:
        return t
    chs = nav(resp, "results", "channels") or []
    if chs:
        alts = chs[0].get("alternatives", [])
        if alts and "transcript" in alts[0]:
            return alts[0]["transcript"]
    return ""


# ---------- Deepgram transcription ----------
def transcribe_audio_file(file_path):
    try:
        with open(file_path, "rb") as f:
            buffer_data = f.read()
        try:
            response = dg.listen.v1.media.transcribe_file(
                request=buffer_data,
                model="nova-3",
                language="en",
                smart_format=True,
                diarize=False,
                utterances=False
            )
        except Exception as ve:
            # validation warnings sometimes happen because of pydantic strict types
            print(f"⚠️ Validation warning: {str(ve)[:200]}")
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

    IMPORTANT:
    - Every node MUST have a non-empty field called "label".
    - Do not use other field names like "name", "concept", or "title".
    - "label" must contain the human-readable concept name.

Current mind map state:
{json.dumps(current_json)}

New transcript:
"{transcript}"

Extract main concepts from this transcript and create nodes with relationships. Each node should represent a distinct concept, action, or entity mentioned. For each node, include:
- a unique id
- label (concept name)
- summary (1-2 sentence explanation of the concept in the context of the conversation)
- papers (if any are mentioned)
- relevance score (0.0 to 1.0)

For each edge, include:
- from and to (the ids of the connected nodes)
- reasoning (1-2 sentence explanation of why these nodes are related)

Respond with ONLY a raw JSON object (no markdown, no code blocks, no explanations). Use this exact structure:

{{
  "nodes": [
    {{"id": "unique_id", "label": "Concept Name", "summary": "Short summary", "papers": [], "relevance": 0.0}}
  ],
  "edges": [
    {{"from": "source_id", "to": "target_id", "reasoning": "Why these nodes are connected"}}
  ]
}}"""

    model = genai.GenerativeModel(model_name="gemini-2.5-flash")
    response = model.generate_content([prompt])
    try:
        text = response.candidates[0].content.parts[0].text.strip()
        # strip code fences if present
        if text.startswith("```"):
            lines = text.split("\n")
            json_lines = []
            in_code_block = False
            for line in lines:
                if line.strip().startswith("```"):
                    in_code_block = not in_code_block
                    continue
                if in_code_block or (not line.strip().startswith("```")):
                    json_lines.append(line)
            text = "\n".join(json_lines).strip()
        data = json.loads(text)
        if "nodes" not in data or "edges" not in data:
            print("⚠️ Gemini output missing 'nodes' or 'edges'. Keeping old JSON.")
            return None
        # ensure lists
        if not isinstance(data["nodes"], list) or not isinstance(data["edges"], list):
            print("⚠️ Gemini returned invalid nodes/edges types. Keeping old JSON.")
            return None
        return data
    except Exception as e:
        print(f"⚠️ Invalid Gemini response: {e}")
        return None


# ---------- Lambda ----------
LAMBDA_ENDPOINT_POST = "https://vnh1q99dvc.execute-api.us-east-1.amazonaws.com/data"
LAMBDA_ENDPOINT_READ = LAMBDA_ENDPOINT_POST
UPLOAD_TOKEN = "test"

def transform_for_lambda(gemini_json):
    """
    Convert Gemini mindmap JSON to Lambda schema:
    - Nodes get id, title, summary, papers, relevance
    - Edges get nodeID1, nodeID2, reasoning
    """
    # Map original node IDs to integer IDs for Lambda
    node_id_map = {node['id']: idx+1 for idx, node in enumerate(gemini_json.get('nodes', []))}

    # Transform nodes
    nodes = []
    for node in gemini_json.get('nodes', []):
        nodes.append({
            "id": node_id_map[node['id']],
            "title": node.get('label') or node.get('title') or node.get('name') or "Untitled",
            "summary": node.get('summary', ''),
            "papers": node.get('papers', []),
            "relevance": node.get('relevance', 0.0)
        })


    # Transform edges
    edges = []
    for edge in gemini_json.get('edges', []):
        from_id = node_id_map.get(edge.get('from'))
        to_id = node_id_map.get(edge.get('to'))
        if from_id and to_id:
            edges.append({
                "nodeID1": from_id,
                "nodeID2": to_id,
                "reasoning": edge.get('reasoning', '')
            })

    return {"nodes": nodes, "edges": edges}


def post_json_to_lambda(data):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {UPLOAD_TOKEN}"
    }
    try:
        response = requests.post(LAMBDA_ENDPOINT_POST, json=data, headers=headers, timeout=10)
        if response.status_code == 200:
            print("✅ Successfully posted mindmap JSON to Lambda.")
        else:
            print(f"⚠️ Lambda returned status {response.status_code}: {response.text}")
    except Exception as e:
        print(f"⚠️ Failed to post JSON to Lambda: {e}")


def fetch_json_from_lambda():
    headers = {
        "Authorization": f"Bearer {UPLOAD_TOKEN}",
        "Cache-Control": "no-cache"
    }
    try:
        response = requests.get(LAMBDA_ENDPOINT_READ, headers=headers, timeout=10)
        if response.status_code == 200:
            raw = response.json()
            # handle wrappers like { data: {...} } used by your frontend
            candidate = raw.get("data") if isinstance(raw, dict) and raw.get("data") is not None else raw
            # validate shape
            if isinstance(candidate, dict) and isinstance(candidate.get("nodes"), list) and isinstance(candidate.get("edges"), list):
                print("🌐 Fetched latest mindmap from Lambda.")
                return candidate
            else:
                print("⚠️ Lambda GET returned JSON of unexpected shape; ignoring.")
                return None
        else:
            print(f"⚠️ Lambda GET returned {response.status_code}: {response.text}")
            return None
    except Exception as e:
        print(f"⚠️ Failed to fetch JSON from Lambda: {e}")
        return None


# ---------- Gemini worker ----------
def gemini_worker():
    global mindmap_json
    while True:
        chunk_data = chunk_queue.get()
        if chunk_data is None:
            break

        try:
            # Try to fetch latest remote copy; use it only if valid
            remote_json = fetch_json_from_lambda()
            if remote_json:
                # ensure nodes/edges exist and are lists
                if not isinstance(remote_json.get("nodes"), list):
                    remote_json["nodes"] = []
                if not isinstance(remote_json.get("edges"), list):
                    remote_json["edges"] = []
                mindmap_json = remote_json

            chunk_file, chunk_transcript = chunk_data

            # defensive: ensure local structure
            if "nodes" not in mindmap_json or not isinstance(mindmap_json["nodes"], list):
                mindmap_json["nodes"] = []
            if "edges" not in mindmap_json or not isinstance(mindmap_json["edges"], list):
                mindmap_json["edges"] = []

            new_json = process_with_gemini(chunk_transcript, mindmap_json)

            if new_json:
                # Ensure new_json is valid
                if not isinstance(new_json.get("nodes"), list):
                    new_json["nodes"] = []
                if not isinstance(new_json.get("edges"), list):
                    new_json["edges"] = []

                # Merge nodes by id (string id from Gemini)
                existing_nodes_by_id = {node['id']: node for node in mindmap_json.get("nodes", []) if isinstance(node, dict) and 'id' in node}

                for node in new_json.get("nodes", []):
                    # Defensive checks
                    if not isinstance(node, dict) or 'id' not in node:
                        continue
                    node_id = node.get("id")
                    if node_id in existing_nodes_by_id:
                        existing_node = existing_nodes_by_id[node_id]
                        # merge papers (union), preserve existing summary if new summary absent
                        existing_node['papers'] = list(set(existing_node.get('papers', []) + node.get('papers', [])))
                        if 'relevance' in node:
                            existing_node['relevance'] = max(existing_node.get('relevance', 0), node['relevance'])
                        # replace summary if provided (keeps existing otherwise)
                        if 'summary' in node and node.get('summary'):
                            existing_node['summary'] = node.get('summary')
                    else:
                        # ensure node has expected fields
                        if 'papers' not in node:
                            node['papers'] = []
                        if 'relevance' not in node:
                            node['relevance'] = 0.0
                        if 'summary' not in node:
                            node['summary'] = ""
                        mindmap_json["nodes"].append(node)

                # Append edges (defensive)
                for edge in new_json.get("edges", []):
                    if not isinstance(edge, dict):
                        continue
                    # simple append; could dedupe if needed
                    mindmap_json["edges"].append(edge)

                # persist local file
                out_path = Path("mindmap.json")
                out_path.write_text(json.dumps(mindmap_json, indent=2), encoding="utf-8")
                print(f"✅ mindmap.json updated with Gemini insights from {chunk_file}")

                # Transform to Lambda's expected schema and post
                lambda_json = transform_for_lambda(mindmap_json)
                post_json_to_lambda(lambda_json)
            else:
                print(f"⚠️ No valid Gemini JSON for {chunk_file}. Old data preserved.")
        except Exception as e:
            print(f"⚠️ Error in gemini_worker processing: {e}")
        finally:
            # always mark the queue task done
            try:
                chunk_queue.task_done()
            except Exception:
                pass


# ---------- Main ----------
def main():
    global audio_buffer, is_recording, CHANNELS
    found = find_hyperx_device()
    if found is None:
        print(f"❌ Could not find a device named '{MATCH_NAME}'.")
        return
    device_index, device_info = found
    CHANNELS = device_info['max_input_channels']
    print(f"🎯 Using device index {device_index}: {device_info['name']}")
    print(f"📝 Detected channels: {CHANNELS}")
    print("Press 'r' to start, 's' to stop.")

    worker_thread = Thread(target=gemini_worker, daemon=True)
    worker_thread.start()

    chunk_count = 0
    chunk_start_time = None
    try:
        with sd.InputStream(samplerate=SAMPLE_RATE, channels=CHANNELS,
                    callback=audio_callback, device=device_index,
                    blocksize=BLOCKSIZE):
            while True:
                if keyboard.is_pressed('r') and not is_recording:
                    audio_buffer = []
                    is_recording = True
                    chunk_start_time = time.time()
                    print("🔴 Recording started...")
                    time.sleep(0.3)
                if keyboard.is_pressed('s') and is_recording:
                    is_recording = False
                    print("🛑 Recording stopped.")
                    time.sleep(0.3)
                    break
                if is_recording and audio_buffer:
                    elapsed = time.time() - chunk_start_time
                    if elapsed >= CHUNK_DURATION:
                        chunk_count += 1
                        chunk_audio = np.concatenate(audio_buffer, axis=0)
                        if CHANNELS == 1:
                            chunk_audio = chunk_audio.flatten()
                        chunk_audio = normalize_audio(chunk_audio)
                        chunk_int16 = np.int16(np.clip(chunk_audio, -1, 1) * 32767)
                        temp_file = f"chunk_{chunk_count}.wav"
                        write(temp_file, SAMPLE_RATE, chunk_int16)
                        transcript = transcribe_audio_file(temp_file)
                        print(f"\n🎤 Transcript chunk {chunk_count}: {transcript}")
                        chunk_queue.put((temp_file, transcript))
                        audio_buffer = []
                        chunk_start_time = time.time()
        # final buffer flush
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
    chunk_queue.put(None)
    worker_thread.join()
    print("✅ All chunks processed. Final mindmap.json saved.")


if __name__ == "__main__":
    main()
