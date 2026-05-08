from typing import Any

from flask import Flask, jsonify
from pydantic import BaseModel
from werkzeug.exceptions import HTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, *,
                 hint: str | None = None, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.details = details or {}


class ApiErrorBody(BaseModel):
    code: str
    message: str
    hint: str | None = None
    details: dict[str, Any] = {}


def register_error_handlers(app: Flask) -> None:

    @app.errorhandler(ApiError)
    def _handle_api_error(err: ApiError):
        body = ApiErrorBody(code=err.code, message=err.message,
                            hint=err.hint, details=err.details)
        return jsonify(body.model_dump()), err.status

    @app.errorhandler(HTTPException)
    def _handle_http(err: HTTPException):
        body = ApiErrorBody(code=f"http_{err.code}", message=err.description or err.name)
        return jsonify(body.model_dump()), err.code

    @app.errorhandler(Exception)
    def _handle_unhandled(err: Exception):
        body = ApiErrorBody(code="internal_error", message=str(err) or "Internal Server Error")
        return jsonify(body.model_dump()), 500
