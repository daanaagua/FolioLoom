from src.core.preprocessor import TextPreprocessor


def test_word_numbered_books_create_distinct_volume_scopes():
    source = """Front matter

Book One

I

First chapter.

Book Two

I

Second chapter.
"""

    chapters = TextPreprocessor().split_chapters(source)

    ids = [chapter_id for chapter_id, _title, _source in chapters]
    assert "v01_ch01" in ids
    assert "v02_ch01" in ids
    assert len(ids) == len(set(ids))


def test_repeated_chapter_labels_never_overwrite_artifact_ids():
    source = """I

First occurrence.

I

Second occurrence.
"""

    chapters = TextPreprocessor().split_chapters(source)

    ids = [chapter_id for chapter_id, _title, _source in chapters]
    assert ids == ["v01_ch01", "v01_ch01_02"]
