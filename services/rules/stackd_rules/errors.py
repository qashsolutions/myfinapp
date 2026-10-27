"""The one exception rules raise for bad input."""


class RuleError(ValueError):
    """Raised with a stable snake_case code. Golden tests see it as {"error": code}."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code
