"""Offline tests for upstream multi-page image batching."""
import asyncio
import base64
import json
from io import BytesIO
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from mimi_douyin import perception
from mimi_douyin import image_perception
from mimi_douyin.errors import BrowserError


def owner_for(tmp_path, generate, **config):
    return NS(config={"video_provider_id": "mock", **config}, media_dir=str(tmp_path),
              video_transcription_lock=asyncio.Lock(),
              ledger=NS(get=lambda _: None, put=lambda *args: None),
              context=NS(get_provider_by_id=lambda _: NS(get_model=lambda: "mock"),
                         llm_generate=generate))


def response(text="逐页事实"):
    return NS(role="assistant", completion_text=json.dumps(
        {"summary": text, "onscreen_text": text}))


def images(tmp_path, count):
    paths=[]
    for index in range(count):
        path=tmp_path / f"page-{index}.png"
        Image.new("RGB", (400, 600), "white").save(path)
        paths.append(str(path))
    return paths


def test_pages_batch_with_global_order(tmp_path):
    generate=AsyncMock(return_value=response())
    result=asyncio.run(perception.transcribe_video(
        owner_for(tmp_path, generate), [{"images": images(tmp_path, 13)}]))
    assert generate.call_count == 4
    counts=[sum(part.type == "image_url" for part in call.kwargs["contexts"][-1].content)
            for call in generate.call_args_list[:3]]
    assert counts == [6, 6, 1]
    assert any("13/13" in part.text for part in generate.call_args_list[2].kwargs["contexts"][-1].content if part.type == "text")
    assert result["image_coverage"]["status"] == "all_images_submitted"
    assert len(result["image_batch_evidence"]) == 3


def test_tall_image_keeps_overlapping_tiles(tmp_path):
    path=tmp_path / "long.png"
    Image.new("RGB", (600, 6000), "white").save(path)
    generate=AsyncMock(return_value=response())
    result=asyncio.run(perception.transcribe_video(
        owner_for(tmp_path, generate), [{"images": [str(path)]}]))
    parts=generate.call_args_list[0].kwargs["contexts"][-1].content
    sizes=[Image.open(BytesIO(base64.b64decode(part.image_url["url"].split(",", 1)[1]))).size
           for part in parts if part.type == "image_url"]
    assert len(sizes) > 1 and all(width == 600 and height <= 1536 for width, height in sizes)
    records=result["image_coverage"]["tiles"]
    assert records[0]["box"][1] == 0 and records[-1]["box"][3] == 6000
    assert all(first["box"][3] > second["box"][1] for first, second in zip(records, records[1:]))


def test_per_post_limit_is_not_flattened(tmp_path):
    generate=AsyncMock(return_value=response())
    pages=images(tmp_path, 20)
    result=asyncio.run(perception.transcribe_video(owner_for(tmp_path, generate),
        [{"images": pages}, {"images": pages}]))
    assert result["inspected_image_count"] == 40
    assert result["image_coverage"]["tiles"][-1]["source_index"] == 2


def test_configured_limit_is_kept(tmp_path):
    generate=AsyncMock(return_value=response())
    with pytest.raises(BrowserError, match="数量超过设置"):
        asyncio.run(perception.transcribe_video(owner_for(tmp_path, generate, max_post_images=2),
            [{"images": images(tmp_path, 3)}]))
    generate.assert_not_awaited()


def test_pixel_limit_fails_before_provider(tmp_path):
    path=tmp_path / "huge.png"
    Image.new("1", (6400, 6400)).save(path)
    generate=AsyncMock(return_value=response())
    with pytest.raises(BrowserError, match="像素超过"):
        asyncio.run(perception.transcribe_video(owner_for(tmp_path, generate),
            [{"images": [str(path)]}]))
    generate.assert_not_awaited()


def test_ocr_tail_is_retained_separately(tmp_path):
    raw="正文" * 6500 + "末页反转"
    generate=AsyncMock(return_value=NS(role="assistant", completion_text=json.dumps(
        {"summary": "候选", "onscreen_text": raw})))
    result=asyncio.run(perception.transcribe_video(owner_for(tmp_path, generate),
        [{"images": images(tmp_path, 1)}]))
    evidence=result["image_batch_evidence"][0]["ocr_evidence"]
    assert evidence["truncated"] and evidence["text"].endswith("末页反转")
    assert evidence["char_ranges"] == [[0, 8000], [len(raw)-4000, len(raw)]]


def test_invalid_json_has_bounded_diagnostic(tmp_path):
    raw="not JSON " + "字" * 9000
    generate=AsyncMock(return_value=NS(role="assistant", completion_text=raw))
    with pytest.raises(BrowserError) as caught:
        asyncio.run(perception.transcribe_video(owner_for(tmp_path, generate),
            [{"images": images(tmp_path, 1)}]))
    diagnostic=caught.value.perception_diagnostic
    assert diagnostic["raw_output"] == raw[:8000]
    assert diagnostic["coverage"]["completed_batches"] == 0


def test_batch_byte_budget_splits():
    original=image_perception.BATCH_BYTES
    image_perception.BATCH_BYTES=1100
    try:
        tiles=[({}, "label", "x" * 40), ({}, "label", "x" * 40)]
        assert list(map(len, image_perception.make_batches(tiles))) == [1, 1]
    finally:
        image_perception.BATCH_BYTES=original
