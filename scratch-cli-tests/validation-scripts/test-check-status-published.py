# Scratch CLI validator: errors when a record's status field is not "published".
# Wire up in validation.json with `{"validator": "python:validators/test-check-status-published.py", "field": "status"}`.

def validate(ctx):
    value = ctx["value"]
    if value != "published":
        actual = "null" if value is None else repr(value)
        return [
            {
                "level": "error",
                "message": f"status must be 'published', got {actual}",
                "fixable": False,
            }
        ]
    return []
