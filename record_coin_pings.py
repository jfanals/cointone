#!/usr/bin/env python3
"""Record labelled coin pings as WAV files with JSON annotations.

Examples:
  python3 record_coin_pings.py --list-devices
  python3 record_coin_pings.py --coin Sovereign --coin-id sov-1912-a
  python3 record_coin_pings.py --coin Sovereign --coin-id sov-1912-a --count 10
  python3 record_coin_pings.py --coin Krugerrand --year 1978 --device 2

Install the one dependency with:
  python3 -m pip install -r requirements-recorder.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def slug(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return result or "unknown"


def load_audio_modules():
    try:
        import numpy as np
        import sounddevice as sd
    except ImportError:
        print(
            "Missing recording dependency. Run:\n"
            "  python3 -m pip install -r requirements-recorder.txt",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return np, sd


def parse_device(value: str | None) -> int | str | None:
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return value


def write_pcm16_wav(path: Path, samples: Any, sample_rate: int, np: Any) -> None:
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def audio_statistics(samples: Any, np: Any) -> dict[str, Any]:
    values = samples.reshape(-1).astype(np.float64)
    peak = float(np.max(np.abs(values))) if values.size else 0.0
    rms = float(math.sqrt(float(np.mean(values * values)))) if values.size else 0.0
    clipping_fraction = float(np.mean(np.abs(values) >= 0.98)) if values.size else 0.0
    dbfs = 20.0 * math.log10(max(rms, 1e-12))

    warnings: list[str] = []
    if peak >= 0.98:
        warnings.append("clipping_detected")
    if dbfs < -50.0:
        warnings.append("recording_may_be_too_quiet")

    return {
        "peak": round(peak, 6),
        "rms": round(rms, 6),
        "rms_dbfs": round(dbfs, 2),
        "clipping_fraction": round(clipping_fraction, 8),
        "warnings": warnings,
    }


def optional_float(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Record labelled coin pings to WAV plus JSON sidecar files."
    )
    parser.add_argument("--coin", help="Coin type/label, e.g. Sovereign")
    parser.add_argument("--coin-id", help="Unique ID for this physical coin")
    parser.add_argument("--year", help="Coin year")
    parser.add_argument("--mass-g", type=float, help="Measured mass in grams")
    parser.add_argument("--diameter-mm", type=float, help="Measured diameter in mm")
    parser.add_argument("--thickness-mm", type=float, help="Measured thickness in mm")
    parser.add_argument("--notes", default="", help="Session-level notes")
    parser.add_argument(
        "--count",
        type=int,
        help="Maximum number of kept pings (default: continue until you choose to stop)",
    )
    parser.add_argument("--duration", type=float, default=3.0, help="Seconds per recording (default: 3)")
    parser.add_argument("--sample-rate", type=int, default=48000, help="Sample rate (default: 48000)")
    parser.add_argument("--device", help="Input device index or name")
    parser.add_argument("--output", default="recordings", help="Dataset directory")
    parser.add_argument("--session", help="Session ID; generated if omitted")
    parser.add_argument("--annotate-each", action="store_true", help="Prompt for notes after each ping")
    parser.add_argument("--list-devices", action="store_true", help="List audio devices and exit")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    np, sd = load_audio_modules()

    if args.list_devices:
        print(sd.query_devices())
        return 0

    coin = (args.coin or input("Coin type/label (e.g. Sovereign): ")).strip()
    if not coin:
        print("Coin label cannot be empty.", file=sys.stderr)
        return 2
    coin_id = (args.coin_id or input("Physical coin ID (recommended; Enter to omit): ")).strip()

    if (args.count is not None and args.count < 1) or args.duration <= 0 or args.sample_rate < 8000:
        print("Count and duration must be positive; sample rate must be at least 8000.", file=sys.stderr)
        return 2

    device = parse_device(args.device)
    try:
        sd.check_input_settings(device=device, channels=1, dtype="float32", samplerate=args.sample_rate)
        device_info = dict(sd.query_devices(device, "input"))
        host_apis = sd.query_hostapis()
        host_api_name = host_apis[device_info["hostapi"]]["name"]
    except Exception as error:
        print(f"Cannot use audio input: {error}", file=sys.stderr)
        print("Run with --list-devices, then select one using --device INDEX.", file=sys.stderr)
        return 2

    session = args.session or datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = Path(args.output).expanduser() / slug(coin) / slug(coin_id or "unspecified") / slug(session)
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = Path(args.output).expanduser() / "manifest.jsonl"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    session_metadata = {
        "coin_label": coin,
        "coin_id": coin_id or None,
        "year": args.year or None,
        "mass_g": args.mass_g,
        "diameter_mm": args.diameter_mm,
        "thickness_mm": args.thickness_mm,
        "session_id": session,
        "session_notes": args.notes,
    }
    device_metadata = {
        "name": device_info.get("name"),
        "index": device_info.get("index"),
        "host_api": host_api_name,
        "requested_sample_rate_hz": args.sample_rate,
        "device_default_sample_rate_hz": device_info.get("default_samplerate"),
        "channels": 1,
        "sample_format": "PCM signed 16-bit little-endian",
    }

    print(f"\nCoin: {coin} ({coin_id or 'no physical ID'})")
    print(f"Input: {device_metadata['name']} via {host_api_name}")
    print(f"Output: {output_dir}")
    print("For each take: press Enter, wait for 'PING NOW', then strike the coin once.")
    print("After listening to the result, choose to keep it, retry it, or stop.")
    if args.count is None:
        print("Recording continues until you choose to stop.\n")
    else:
        print(f"Recording stops after {args.count} kept ping(s), or sooner if you choose.\n")

    saved = 0
    retry_count = 0
    stop_requested = False
    try:
        while args.count is None or saved < args.count:
            take = saved + 1
            progress = f"{take}/{args.count}" if args.count is not None else str(take)
            response = input(f"[Take {progress}] Enter to arm (or q to quit): ").strip().lower()
            if response in {"q", "quit"}:
                break

            frames = round(args.duration * args.sample_rate)
            started_at = utc_now()
            try:
                recording = sd.rec(
                    frames,
                    samplerate=args.sample_rate,
                    channels=1,
                    dtype="float32",
                    device=device,
                    blocking=False,
                )
                # Leave a short pre-impact region for noise-floor and onset analysis.
                time.sleep(min(0.25, args.duration / 4))
                print("  PING NOW!", flush=True)
                sd.wait()
            except KeyboardInterrupt:
                sd.stop()
                raise
            except Exception as error:
                sd.stop()
                print(f"  Recording failed: {error}", file=sys.stderr)
                retry_count += 1
                continue

            stats = audio_statistics(recording, np)
            warning_text = f"; warnings: {', '.join(stats['warnings'])}" if stats["warnings"] else ""
            print(
                f"  Captured: peak {stats['peak']:.3f}, "
                f"RMS {stats['rms_dbfs']} dBFS{warning_text}"
            )
            decision = input("  [K]eep, [r]etry this take, or [q]uit without keeping? ").strip().lower()
            if decision in {"r", "retry"}:
                retry_count += 1
                print("  Discarded. Arm the same take again.\n")
                continue
            if decision in {"q", "quit"}:
                print("  Discarded the last capture.")
                stop_requested = True
                break

            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
            stem = f"{slug(coin)}_{slug(coin_id or 'unknown')}_{timestamp}_take-{take:03d}"
            wav_path = output_dir / f"{stem}.wav"
            json_path = output_dir / f"{stem}.json"
            write_pcm16_wav(wav_path, recording, args.sample_rate, np)

            take_notes = ""
            if args.annotate_each:
                take_notes = input("  Take notes (strike method, distance, problems; Enter to skip): ").strip()

            annotation = {
                "schema_version": 1,
                "created_at_utc": started_at,
                "audio_file": wav_path.name,
                "audio_sha256": sha256(wav_path),
                "duration_seconds": args.duration,
                "take_number": take,
                "take_notes": take_notes,
                **session_metadata,
                "recording": device_metadata,
                "quality": stats,
            }
            json_path.write_text(json.dumps(annotation, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

            manifest_record = dict(annotation)
            manifest_record["audio_file"] = str(wav_path)
            manifest_record["annotation_file"] = str(json_path)
            with manifest_path.open("a", encoding="utf-8") as manifest:
                manifest.write(json.dumps(manifest_record, ensure_ascii=False) + "\n")

            saved += 1
            print(f"  Kept {wav_path.name}\n")

            if args.count is None or saved < args.count:
                decision = input("Record another ping? [Y/n]: ").strip().lower()
                if decision in {"n", "no", "q", "quit"}:
                    stop_requested = True
                    break
    except KeyboardInterrupt:
        print("\nStopped.")

    if stop_requested:
        print("Session finished by user.")

    retry_text = f"; discarded/retried {retry_count}" if retry_count else ""
    print(f"Saved {saved} recording(s){retry_text}. Manifest: {manifest_path}")
    return 0 if saved else 1


if __name__ == "__main__":
    raise SystemExit(main())
