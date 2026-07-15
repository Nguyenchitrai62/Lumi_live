"""Minimal Gemini Live audio + screen-sharing sample.

Reads GEMINI_API_KEY from the environment or the project's .env file.
Press q in the terminal to exit. The default visual input is screen capture.
"""

import argparse
import asyncio
import io
import os
import traceback

import cv2
import mss
import PIL.Image
import pyaudio
from dotenv import load_dotenv
from google import genai
from google.genai import types


load_dotenv()

FORMAT = pyaudio.paInt16
CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024

MODEL = "gemini-3.1-flash-live-preview"
DEFAULT_MODE = "screen"

client = genai.Client(
    http_options={"api_version": "v1beta"},
    api_key=os.environ.get("GEMINI_API_KEY"),
)

CONFIG = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    media_resolution="MEDIA_RESOLUTION_MEDIUM",
    speech_config=types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Zephyr")
        )
    ),
)


class AudioLoop:
    def __init__(self, video_mode: str = DEFAULT_MODE):
        self.video_mode = video_mode
        self.audio_in_queue: asyncio.Queue[bytes] | None = None
        self.out_queue: asyncio.Queue[dict] | None = None
        self.session = None
        self.audio_stream = None
        self.pya = pyaudio.PyAudio()

    async def send_text(self):
        while True:
            text = await asyncio.to_thread(input, "speak or type 'q' to quit > ")
            if text.lower() == "q":
                break
            if self.session is not None:
                await self.session.send_realtime_input(text=text or ".")

    def _get_screen(self):
        with mss.mss() as capture:
            shot = capture.grab(capture.monitors[0])
            image = PIL.Image.frombytes("RGB", shot.size, shot.rgb)
            image.thumbnail((1024, 1024))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=80)
            return {"mime_type": "image/jpeg", "data": output.getvalue()}

    async def get_screen(self):
        while True:
            frame = await asyncio.to_thread(self._get_screen)
            if self.out_queue is not None:
                await self.out_queue.put(frame)
            await asyncio.sleep(1.0)

    def _get_camera_frame(self, camera):
        success, frame = camera.read()
        if not success:
            return None
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = PIL.Image.fromarray(rgb_frame)
        image.thumbnail((1024, 1024))
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=80)
        return {"mime_type": "image/jpeg", "data": output.getvalue()}

    async def get_camera(self):
        camera = await asyncio.to_thread(cv2.VideoCapture, 0)
        try:
            while True:
                frame = await asyncio.to_thread(self._get_camera_frame, camera)
                if frame is None:
                    break
                if self.out_queue is not None:
                    await self.out_queue.put(frame)
                await asyncio.sleep(1.0)
        finally:
            camera.release()

    async def send_realtime(self):
        while True:
            if self.out_queue is None:
                await asyncio.sleep(0.05)
                continue
            message = await self.out_queue.get()
            if self.session is None:
                continue
            blob = types.Blob(data=message["data"], mime_type=message["mime_type"])
            if message["mime_type"].startswith("audio/"):
                await self.session.send_realtime_input(audio=blob)
            else:
                await self.session.send_realtime_input(video=blob)

    async def listen_audio(self):
        mic_info = self.pya.get_default_input_device_info()
        self.audio_stream = await asyncio.to_thread(
            self.pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=SEND_SAMPLE_RATE,
            input=True,
            input_device_index=mic_info["index"],
            frames_per_buffer=CHUNK_SIZE,
        )
        while True:
            data = await asyncio.to_thread(
                self.audio_stream.read,
                CHUNK_SIZE,
                exception_on_overflow=False,
            )
            if self.out_queue is not None:
                await self.out_queue.put(
                    {"data": data, "mime_type": "audio/pcm;rate=16000"}
                )

    async def receive_audio(self):
        while True:
            if self.session is None or self.audio_in_queue is None:
                await asyncio.sleep(0.05)
                continue
            turn = self.session.receive()
            async for response in turn:
                if response.data:
                    self.audio_in_queue.put_nowait(response.data)
                if response.text:
                    print(response.text, end="", flush=True)
                server_content = response.server_content
                if server_content and server_content.interrupted:
                    while not self.audio_in_queue.empty():
                        self.audio_in_queue.get_nowait()

    async def play_audio(self):
        stream = await asyncio.to_thread(
            self.pya.open,
            format=FORMAT,
            channels=CHANNELS,
            rate=RECEIVE_SAMPLE_RATE,
            output=True,
        )
        while True:
            if self.audio_in_queue is None:
                await asyncio.sleep(0.05)
                continue
            audio = await self.audio_in_queue.get()
            await asyncio.to_thread(stream.write, audio)

    async def run(self):
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY is missing from .env or the environment")

        try:
            async with (
                client.aio.live.connect(model=MODEL, config=CONFIG) as session,
                asyncio.TaskGroup() as tasks,
            ):
                self.session = session
                self.audio_in_queue = asyncio.Queue()
                self.out_queue = asyncio.Queue(maxsize=5)

                send_text_task = tasks.create_task(self.send_text())
                tasks.create_task(self.send_realtime())
                tasks.create_task(self.listen_audio())
                tasks.create_task(self.receive_audio())
                tasks.create_task(self.play_audio())
                if self.video_mode == "screen":
                    tasks.create_task(self.get_screen())
                elif self.video_mode == "camera":
                    tasks.create_task(self.get_camera())

                await send_text_task
                raise asyncio.CancelledError("User requested exit")
        except asyncio.CancelledError:
            pass
        except ExceptionGroup as error_group:
            traceback.print_exception(error_group)
        finally:
            if self.audio_stream is not None:
                self.audio_stream.close()
            self.pya.terminate()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        type=str,
        default=DEFAULT_MODE,
        choices=["camera", "screen", "none"],
        help="Visual input streamed to Gemini (default: screen)",
    )
    args = parser.parse_args()
    asyncio.run(AudioLoop(video_mode=args.mode).run())
