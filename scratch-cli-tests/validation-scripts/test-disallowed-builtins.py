# Scratch CLI validator: intentionally invalid — exercises the sandbox by calling
# built-ins that are stripped from the embedded Python (eval/exec). Expected to
# fail at load or execution time, never to produce real validation output.

def validate(ctx):
    expr = "1 + 1"
    result = eval(expr)
    exec("x = 2 + 2")
    return [
        {
            "level": "warning",
            "message": f"sandbox let eval/exec through (got {result})",
            "fixable": False,
        }
    ]
