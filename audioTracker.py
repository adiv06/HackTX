import sounddevice as sd
import numpy as np
from scipy.io.wavfile import write
import keyboard
import time
from getpass import getpass
from deepgram import DeepgramClient
import pathlib

# ---------- Recording settings ----------
SAMPLE_RATE = 48000
MATCH_NAME = "HyperX QuadCast S"
audio_buffer = []
is_recording = False
CHANNELS = 1
CHUNK_DURATION = 30  # seconds per transcription chunk

# ---------- Deepgram helpers ----------
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

def first_transcript(resp):
    t = nav(resp, "results", "channels", 0, "alternatives", 0, "transcript")
    if t: return t
    chs = nav(resp, "results", "channels") or []
    if chs:
        alts = chs[0].get("alternatives", [])
        if alts and "transcript" in alts[0]:
            return alts[0]["transcript"]
    return ""

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

# ---------- Main ----------
def main():
    global audio_buffer, is_recording, CHANNELS

    # Find the mic
    found = find_hyperx_device()
    if found is None:
        print(f"❌ Could not find a device named '{MATCH_NAME}'.")
        return

    device_index, device_info = found
    hostapi_name = sd.query_hostapis()[device_info['hostapi']]['name']
    CHANNELS = device_info['max_input_channels']
    print(f"🎯 Using device index {device_index}: {device_info['name']} (Host API: {hostapi_name})")
    print(f"📝 Detected channels: {CHANNELS}")
    print("Instructions: press 'r' to start recording, press 's' to stop and save.")

    # Deepgram authentication
    # DG_KEY = getpass("Deepgram SECRET: ").strip()
    DG_KEY = "e0d3e3023710cafae5972209007dd26f94077dc6"
    dg = DeepgramClient(api_key=DG_KEY)

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

                # Check if we have a chunk ready
                if is_recording and audio_buffer:
                    elapsed = time.time() - chunk_start_time
                    if elapsed >= CHUNK_DURATION:
                        chunk_count += 1
                        # Concatenate and flatten if mono
                        chunk_audio = np.concatenate(audio_buffer, axis=0)
                        if CHANNELS == 1:
                            chunk_audio = chunk_audio.flatten()
                        chunk_audio = normalize_audio(chunk_audio)
                        chunk_int16 = np.int16(np.clip(chunk_audio, -1, 1) * 32767)

                        # Save temporary chunk
                        temp_file = f"chunk_{chunk_count}.wav"
                        write(temp_file, SAMPLE_RATE, chunk_int16)

                        # Send to Deepgram
                        with open(temp_file, "rb") as f:
                            resp = dg.listen.v1.media.transcribe_file(
                                request=f.read(),
                                model="nova-3",
                                language="en",
                                smart_format=True
                            )

                        # Print transcript
                        print(f"\n🎤 Transcript for chunk {chunk_count}:")
                        print(first_transcript(resp))

                        # Reset buffer and timer for next chunk
                        audio_buffer = []
                        chunk_start_time = time.time()

        # Optional: save final remaining audio after stopping
        if audio_buffer:
            final_audio = np.concatenate(audio_buffer, axis=0)
            if CHANNELS == 1:
                final_audio = final_audio.flatten()
            final_audio = normalize_audio(final_audio)
            final_int16 = np.int16(np.clip(final_audio, -1, 1) * 32767)
            final_file = "final_recording.wav"
            write(final_file, SAMPLE_RATE, final_int16)
            print(f"💾 Saved final recording: {final_file}")

    except Exception as e:
        print("❌ Error:", e)

if __name__ == "__main__":
    main()
