"""Versioned HTTP payloads for the extension bridge."""

from __future__ import annotations

import math
import re
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .normalize import is_ed2k, is_magnet, normalize_code, parse_ed2k


def _validate_bounded_json(value: Any, *, field_name: str) -> Any:
    """Keep nested JSON payloads finite and bounded before persistence."""

    max_depth = 6
    max_nodes = 200
    max_string = 4096
    max_bytes = 256 * 1024
    count = 0

    def visit(item: Any, depth: int) -> Any:
        nonlocal count
        count += 1
        if count > max_nodes:
            raise ValueError(f"{field_name} 项目数量超出限制")
        if depth > max_depth:
            raise ValueError(f"{field_name} 嵌套深度超出限制")
        if isinstance(item, str):
            if len(item) > max_string:
                raise ValueError(f"{field_name} 字符串过长")
            return item
        if item is None or isinstance(item, (bool, int)):
            return item
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError(f"{field_name} 不得包含非有限浮点数")
            return item
        if isinstance(item, list):
            if len(item) > max_nodes:
                raise ValueError(f"{field_name} 数组过长")
            return [visit(child, depth + 1) for child in item]
        if isinstance(item, dict):
            if len(item) > max_nodes:
                raise ValueError(f"{field_name} 对象过大")
            result: dict[str, Any] = {}
            for key, child in item.items():
                if not isinstance(key, str) or len(key) > 128:
                    raise ValueError(f"{field_name} 键无效")
                result[key] = visit(child, depth + 1)
            return result
        raise ValueError(f"{field_name} 只能包含 JSON 值")

    normalized = visit(value, 0)
    try:
        encoded = json.dumps(
            normalized,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{field_name} 不是有效 JSON") from None
    if len(encoded) > max_bytes:
        raise ValueError(f"{field_name} 过大")
    return normalized


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class IntentModel(StrictModel):
    job_id: str = Field(..., alias="jobId", min_length=1, max_length=128)
    source_site: str = Field("generic", alias="sourceSite", min_length=1, max_length=64)
    media_type: Literal["generic", "jav", "anime"] = Field(
        "generic", alias="mediaType"
    )
    processor_profile: Literal["generic", "jav", "anime"] = Field(
        "generic", alias="processorProfile"
    )
    url: str = Field(..., min_length=1, max_length=8192)
    title: str = Field("", max_length=512)
    code: str = Field("", max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)
    save_path_cid: str | None = Field(
        None, alias="savePathCid", max_length=64
    )
    link_type: Literal["magnet", "ed2k"] | None = Field(None, alias="linkType")
    expected_name: str = Field("", alias="expectedName", max_length=1024)
    expected_size: int | None = Field(None, alias="expectedSize", ge=0, le=2**63 - 1)
    expected_hash: str = Field("", alias="expectedHash", max_length=128)

    @field_validator("source_site")
    @classmethod
    def validate_source_site(cls, value: str) -> str:
        value = value.strip()
        if value != value.lower() or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?", value
        ):
            raise ValueError("sourceSite 必须是小写标签")
        return value

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip()
        if not (is_magnet(value) or is_ed2k(value)):
            raise ValueError("intent.url 必须是含 BTIH 的 Magnet 或严格 ED2K file 链接")
        return value

    @field_validator("code")
    @classmethod
    def validate_code(cls, value: str) -> str:
        if not value.strip():
            return ""
        normalized = normalize_code(value)
        if not normalized:
            raise ValueError("intent.code 不是可识别的番号")
        return normalized

    @field_validator("expected_hash")
    @classmethod
    def validate_expected_hash(cls, value: str) -> str:
        value = value.strip().lower()
        if value and not re.fullmatch(r"[0-9a-f]{32,128}", value):
            raise ValueError("expectedHash 必须是 32 到 128 位十六进制哈希")
        return value

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, value: dict[str, Any]) -> dict[str, Any]:
        sensitive_substrings = (
            "token",
            "authorization",
            "cookie",
            "secret",
            "password",
            "credential",
            "header",
        )
        auth_key = re.compile(r"auth(?:entication)?", re.IGNORECASE)

        def is_auth_key(key: str) -> bool:
            folded = key.casefold()
            for match in auth_key.finditer(folded):
                start, end = match.span()
                before = folded[start - 1] if start else ""
                after = folded[end] if end < len(folded) else ""
                original_start = key[start] if start < len(key) else ""
                original_end = key[end] if end < len(key) else ""
                token_start = (
                    not before
                    or not before.isalnum()
                    or original_start.isupper()
                )
                token_end = (
                    not after
                    or not after.isalnum()
                    or original_end.isupper()
                )
                # A suffix such as ``clientAuth`` remains an auth field even
                # when a producer changes the casing of the whole key.
                if token_end and (end == len(folded) or token_start):
                    return True
            return False
        max_depth = 6
        max_nodes = 200
        max_string = 4096
        count = 0

        def visit(item: Any, depth: int) -> Any:
            nonlocal count
            count += 1
            if count > max_nodes:
                raise ValueError("intent.metadata 项目数量超出限制")
            if depth > max_depth:
                raise ValueError("intent.metadata 嵌套深度超出限制")
            if isinstance(item, str):
                if len(item) > max_string:
                    raise ValueError("intent.metadata 字符串过长")
                return item
            if item is None or isinstance(item, (bool, int)):
                return item
            if isinstance(item, float):
                if not math.isfinite(item):
                    raise ValueError("intent.metadata 不得包含非有限浮点数")
                return item
            if isinstance(item, list):
                if len(item) > max_nodes:
                    raise ValueError("intent.metadata 数组过长")
                return [visit(child, depth + 1) for child in item]
            if isinstance(item, dict):
                if len(item) > max_nodes:
                    raise ValueError("intent.metadata 对象过大")
                result: dict[str, Any] = {}
                for key, child in item.items():
                    if not isinstance(key, str) or len(key) > 128:
                        raise ValueError("intent.metadata 键无效")
                    normalized_key = key.strip().casefold()
                    if any(fragment in normalized_key for fragment in sensitive_substrings):
                        raise ValueError("intent.metadata 不得包含敏感字段")
                    if is_auth_key(key.strip()):
                        raise ValueError("intent.metadata 不得包含敏感字段")
                    result[key] = visit(child, depth + 1)
                return result
            raise ValueError("intent.metadata 只能包含 JSON 值")

        return visit(value, 0)

    @model_validator(mode="after")
    def validate_route(self) -> "IntentModel":
        if self.processor_profile == "jav" and not self.code:
            raise ValueError("processorProfile=jav 时 intent.code 不能为空")

        parsed_ed2k = parse_ed2k(self.url)
        inferred_type = "ed2k" if parsed_ed2k is not None else "magnet"
        if self.link_type is not None and self.link_type != inferred_type:
            raise ValueError("linkType 与 intent.url 类型不匹配")
        self.link_type = inferred_type
        if parsed_ed2k is not None:
            expected_name = str(parsed_ed2k["fileName"])
            expected_size = int(parsed_ed2k["size"])
            expected_hash = str(parsed_ed2k["hash"])
            if len(expected_name) > 1024:
                raise ValueError("ED2K 文件名过长")
            if self.expected_name and self.expected_name != expected_name:
                raise ValueError("expectedName 与 ED2K 文件名不匹配")
            if self.expected_size is not None and self.expected_size != expected_size:
                raise ValueError("expectedSize 与 ED2K 文件大小不匹配")
            if self.expected_hash and self.expected_hash != expected_hash:
                raise ValueError("expectedHash 与 ED2K 哈希不匹配")
            self.expected_name = expected_name
            self.expected_size = expected_size
            self.expected_hash = expected_hash
        return self

    @field_validator("save_path_cid")
    @classmethod
    def validate_cid(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return None
        value = value.strip()
        if not re.fullmatch(r"[0-9]{1,64}", value):
            raise ValueError("savePathCid 必须是数字 CID")
        return value


class ClaimRequest(StrictModel):
    schema_version: Literal[1] = Field(1, alias="schema")
    worker_id: str = Field(..., alias="workerId", min_length=1, max_length=128)
    lease_seconds: int = Field(120, alias="leaseSeconds", ge=15, le=900)


class EventRequest(StrictModel):
    schema_version: Literal[1] = Field(1, alias="schema")
    lease_id: str = Field(..., alias="leaseId", min_length=1, max_length=128)
    event_id: str = Field(..., alias="eventId", min_length=1, max_length=128)
    state: Literal["accepted", "progress", "completed", "failed", "uncertain"]
    task_id: str | None = Field(None, alias="taskId", max_length=128)
    remote_id: str | None = Field(None, alias="remoteId", max_length=256)
    percent: float | None = Field(None, ge=0, le=100)
    message: str | None = Field(None, max_length=2048)
    error_code: str | None = Field(None, alias="errorCode", max_length=128)
    error_message: str | None = Field(None, alias="errorMessage", max_length=4096)


class ActionClaimRequest(ClaimRequest):
    pass


class ActionEventRequest(StrictModel):
    schema_version: Literal[1] = Field(1, alias="schema")
    lease_id: str = Field(..., alias="leaseId", min_length=1, max_length=128)
    event_id: str = Field(..., alias="eventId", min_length=1, max_length=128)
    state: Literal["applied", "failed", "uncertain", "noop"]
    result: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = Field(None, alias="errorCode", max_length=128)
    error_message: str | None = Field(None, alias="errorMessage", max_length=4096)

    @field_validator("result")
    @classmethod
    def validate_result(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError("action.result 必须是 JSON 对象")
        return _validate_bounded_json(value, field_name="action.result")


class ActionCommandRequest(StrictModel):
    schema_version: Literal[1] = Field(1, alias="schema")
    request_id: str = Field(..., alias="requestId", min_length=1, max_length=128)
    reason: str = Field("", max_length=512)


def model_dump(value: BaseModel) -> dict[str, Any]:
    return value.model_dump(by_alias=True)
