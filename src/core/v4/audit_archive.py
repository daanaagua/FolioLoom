"""Addressable compressed audit frames and active SQLite size limits."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, Mapping

import zstandard


_SAFE_COMPONENT = re.compile(r"[^A-Za-z0-9_.-]+")


class _CrossProcessFileLock:
    """A small exclusive lock backed by an OS-visible lock file."""

    def __init__(
        self,
        path: Path,
        *,
        timeout_seconds: float = 30.0,
        poll_seconds: float = 0.01,
    ):
        self.path = path
        self.timeout_seconds = max(0.0, float(timeout_seconds))
        self.poll_seconds = max(0.001, float(poll_seconds))
        self._stream = None

    def acquire(self) -> None:
        if self._stream is not None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stream = self.path.open("a+b")
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        deadline = time.monotonic() + self.timeout_seconds
        try:
            if os.name == "nt":
                import msvcrt

                while True:
                    stream.seek(0)
                    try:
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError as exc:
                        if time.monotonic() >= deadline:
                            raise TimeoutError(
                                f"timed out locking audit file: {self.path}"
                            ) from exc
                        time.sleep(self.poll_seconds)
            else:
                import fcntl

                while True:
                    try:
                        fcntl.flock(
                            stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB
                        )
                        break
                    except BlockingIOError as exc:
                        if time.monotonic() >= deadline:
                            raise TimeoutError(
                                f"timed out locking audit file: {self.path}"
                            ) from exc
                        time.sleep(self.poll_seconds)
        except Exception:
            stream.close()
            raise
        self._stream = stream

    def release(self) -> None:
        stream = self._stream
        self._stream = None
        if stream is None:
            return
        try:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        finally:
            stream.close()

    def __enter__(self) -> "_CrossProcessFileLock":
        self.acquire()
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        self.release()


@dataclass(frozen=True)
class AuditLocator:
    """The exact byte range of one independent zstd frame."""

    relative_path: str
    offset: int
    compressed_length: int
    sha256: str

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "AuditLocator":
        return cls(
            relative_path=str(value["relative_path"]),
            offset=int(value["offset"]),
            compressed_length=int(value["compressed_length"]),
            sha256=str(value["sha256"]),
        )


class AuditArchive:
    """Append and retrieve independently compressed JSON audit records."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _component(value: str) -> str:
        cleaned = _SAFE_COMPONENT.sub("_", str(value).strip()).strip("._")
        return cleaned or "unknown"

    def append(
        self,
        run_id: str,
        payload: Mapping[str, Any],
        *,
        stage: str = "audit",
    ) -> AuditLocator:
        transaction = self.begin()
        try:
            locator = transaction.append(run_id, payload, stage=stage)
            transaction.commit()
            return locator
        except Exception:
            transaction.rollback()
            raise

    def begin(self) -> "AuditArchiveTransaction":
        """Start a transaction whose locks live through SQL commit or rollback."""
        return AuditArchiveTransaction(self)

    @staticmethod
    def _encode(payload: Mapping[str, Any]) -> bytes:
        encoded = (
            json.dumps(
                dict(payload),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            + b"\n"
        )
        return zstandard.ZstdCompressor(level=3).compress(encoded)

    def _relative_path(self, run_id: str, stage: str) -> str:
        return f"{self._component(stage)}_{self._component(run_id)}.jsonl.zst"

    def _lock_path(self, relative_path: str) -> Path:
        self._path_for(relative_path)
        return self.root / ".locks" / f"{relative_path}.lock"

    def _path_for(self, relative_path: str) -> Path:
        if not relative_path or Path(relative_path).is_absolute():
            raise ValueError("audit locator path must be relative")
        root = self.root.resolve()
        path = (root / relative_path).resolve()
        try:
            path.relative_to(root)
        except ValueError as exc:
            raise ValueError("audit locator escapes archive root") from exc
        return path

    def read(self, locator: AuditLocator | Mapping[str, Any]) -> dict[str, Any]:
        item = (
            locator
            if isinstance(locator, AuditLocator)
            else AuditLocator.from_mapping(locator)
        )
        if item.offset < 0 or item.compressed_length <= 0:
            raise ValueError("invalid audit locator byte range")
        path = self._path_for(item.relative_path)
        with _CrossProcessFileLock(self._lock_path(item.relative_path)):
            with path.open("rb") as stream:
                stream.seek(item.offset)
                frame = stream.read(item.compressed_length)
        if len(frame) != item.compressed_length:
            raise ValueError("audit frame is truncated")
        if hashlib.sha256(frame).hexdigest() != item.sha256:
            raise ValueError("audit frame checksum mismatch")
        decoded = zstandard.ZstdDecompressor().decompress(frame)
        value = json.loads(decoded.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("audit frame must contain a JSON object")
        return value


@dataclass
class _HeldArchiveFile:
    path: Path
    stream: Any
    lock: _CrossProcessFileLock
    original_size: int


class AuditArchiveTransaction:
    """Hold file locks until the coordinating SQLite transaction resolves."""

    def __init__(self, archive: AuditArchive):
        self.archive = archive
        self._held: dict[str, _HeldArchiveFile] = {}
        self._closed = False

    def _held_file(self, relative_path: str) -> _HeldArchiveFile:
        if self._closed:
            raise RuntimeError("audit archive transaction is already closed")
        existing = self._held.get(relative_path)
        if existing is not None:
            return existing
        path = self.archive._path_for(relative_path)
        lock = _CrossProcessFileLock(self.archive._lock_path(relative_path))
        lock.acquire()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            stream = path.open("a+b")
            stream.seek(0, os.SEEK_END)
            held = _HeldArchiveFile(
                path=path,
                stream=stream,
                lock=lock,
                original_size=stream.tell(),
            )
        except Exception:
            lock.release()
            raise
        self._held[relative_path] = held
        return held

    def append(
        self,
        run_id: str,
        payload: Mapping[str, Any],
        *,
        stage: str = "audit",
    ) -> AuditLocator:
        frame = self.archive._encode(payload)
        relative_path = self.archive._relative_path(run_id, stage)
        held = self._held_file(relative_path)
        held.stream.seek(0, os.SEEK_END)
        offset = held.stream.tell()
        held.stream.write(frame)
        held.stream.flush()
        os.fsync(held.stream.fileno())
        return AuditLocator(
            relative_path=relative_path,
            offset=offset,
            compressed_length=len(frame),
            sha256=hashlib.sha256(frame).hexdigest(),
        )

    @staticmethod
    def _close_and_unlock(held: _HeldArchiveFile) -> None:
        try:
            held.stream.close()
        finally:
            held.lock.release()

    def commit(self) -> None:
        if self._closed:
            return
        self._closed = True
        first_error: Exception | None = None
        for held in reversed(tuple(self._held.values())):
            try:
                self._close_and_unlock(held)
            except Exception as exc:
                first_error = first_error or exc
        self._held.clear()
        if first_error is not None:
            raise first_error

    def rollback(self) -> None:
        if self._closed:
            return
        self._closed = True
        first_error: Exception | None = None
        for held in reversed(tuple(self._held.values())):
            try:
                held.stream.seek(held.original_size)
                held.stream.truncate()
                held.stream.flush()
                os.fsync(held.stream.fileno())
                held.stream.close()
                if held.original_size == 0:
                    held.path.unlink(missing_ok=True)
            except Exception as exc:
                first_error = first_error or exc
                try:
                    held.stream.close()
                except Exception:
                    pass
            finally:
                try:
                    held.lock.release()
                except Exception as exc:
                    first_error = first_error or exc
        self._held.clear()
        if first_error is not None:
            raise first_error


class StorageBudgetExceeded(RuntimeError):
    """The active SQLite database would exceed the per-book hard limit."""

    def __init__(self, active_bytes: int, active_limit: int):
        self.active_bytes = int(active_bytes)
        self.active_limit = int(active_limit)
        super().__init__(
            f"active database budget exceeded: {active_bytes} > {active_limit} bytes"
        )


@dataclass(frozen=True)
class StorageBudget:
    """Predictable active database budget derived from UTF-8 source bytes."""

    SOURCE_MULTIPLIER: ClassVar[int] = 40
    FIXED_ALLOWANCE_BYTES: ClassVar[int] = 64 * 1024**2

    source_bytes: int

    def __post_init__(self) -> None:
        if self.source_bytes < 0:
            raise ValueError("source_bytes must not be negative")

    @property
    def active_limit(self) -> int:
        return (
            self.SOURCE_MULTIPLIER * int(self.source_bytes)
            + self.FIXED_ALLOWANCE_BYTES
        )

    def check(self, active_bytes: int) -> None:
        if int(active_bytes) > self.active_limit:
            raise StorageBudgetExceeded(int(active_bytes), self.active_limit)
