"""Versioned HTTP payloads for the extension bridge."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .normalize import is_magnet, normalize_code


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class IntentModel(StrictModel):
    job_id: str = Field(..., alias="jobId", min_length=1, max_length=128)
    source_site: Literal["javbus", "nyaa"] = Field("javbus", alias="sourceSite")
    media_type: Literal["jav", "anime"] = Field("jav", alias="mediaType")
    processor_profile: Literal["jav", "anime"] = Field("jav", alias="processorProfile")
    url: str = Field(..., min_length=1, max_length=8192)
    title: str = Field("", max_length=512)
    code: str = Field("", max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)
    save_path_cid: str | None = Field(None, alias="savePathCid")

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip()
        if not is_magnet(value):
            raise ValueError("intent.url 必须是含 BTIH 的 Magnet 链接")
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

    @model_validator(mode="after")
    def validate_route(self) -> "IntentModel":
        route = (self.source_site, self.media_type, self.processor_profile)
        if route == ("javbus", "jav", "jav"):
            if not self.code:
                raise ValueError("JavBus intent.code 不能为空")
            return self
        if route == ("nyaa", "anime", "anime"):
            if self.code:
                raise ValueError("Nyaa Anime intent.code 必须为空")
            return self
        raise ValueError("intent 来源、媒体类型和处理规则组合无效")

    @field_validator("save_path_cid")
    @classmethod
    def validate_cid(cls, value: str | None) -> str | None:
        if value is None or value == "":
            return None
        value = value.strip()
        if not value.isdigit():
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


def model_dump(value: BaseModel) -> dict[str, Any]:
    return value.model_dump(by_alias=True)
