"""One error type for the whole backend. main.py turns it into a clean JSON error."""


class AppError(Exception):
    """A failure with a message safe to show the user and the HTTP status to return."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code
