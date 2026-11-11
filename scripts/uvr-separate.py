#!/usr/bin/env python3
"""Run UVR-class MDX-Net (ONNX Runtime) without importing onnx2torch/diffq."""
import argparse
import sys
import types
from pathlib import Path

# audio-separator imports onnx2torch at module load even for the ORT path.
stub = types.ModuleType("onnx2torch")
stub.convert = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("onnx2torch stubbed; use ONNX Runtime (segment_size == dim_t)"))
sys.modules["onnx2torch"] = stub

from audio_separator.separator import Separator  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("--output-dir", required=True)
    p.add_argument("--model-dir", required=True)
    p.add_argument("--model", default="UVR_MDXNET_1_9703.onnx")
    p.add_argument("--output-format", default="WAV")
    args = p.parse_args()

    inp = Path(args.input)
    if not inp.is_file():
        print(f"input missing: {inp}", file=sys.stderr)
        return 1
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    model_dir = Path(args.model_dir)

    separator = Separator(
        model_file_dir=str(model_dir),
        output_dir=str(out),
        output_format=args.output_format,
        mdx_params={"segment_size": 256, "overlap": 0.25, "batch_size": 1, "hop_length": 1024, "enable_denoise": False},
    )
    separator.load_model(model_filename=args.model)
    files = separator.separate(str(inp))
    if not files:
        print("no output files", file=sys.stderr)
        return 1
    for f in files:
        print(f)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
