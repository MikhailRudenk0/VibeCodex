"""Local CPU transcription; PyAV decodes Telegram OGG/Opus directly."""
import sys
from pathlib import Path
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) != 2:
        sys.exit('Использование: transcribe.py <аудиофайл>')
    audio = Path(sys.argv[1])
    if not audio.is_file():
        sys.exit('Аудиофайл не найден.')
    root = Path(__file__).resolve().parent.parent
    model_path = root / 'models' / 'faster-whisper-small'
    if not all((model_path / name).is_file() for name in
               ('model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt')):
        sys.exit('Не установлена локальная модель faster-whisper-small.')
    model = WhisperModel(str(model_path), device='cpu', compute_type='int8', cpu_threads=3,
                         local_files_only=True)
    segments, _ = model.transcribe(str(audio), beam_size=3, vad_filter=True)
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    if not text:
        sys.exit('Речь не распознана: запись пуста, содержит тишину или слишком тихую речь.')
    print(text)


if __name__ == '__main__':
    main()
