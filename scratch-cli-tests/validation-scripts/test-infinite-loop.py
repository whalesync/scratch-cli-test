# Scratch CLI validator: intentionally invalid — spins forever to exercise the
# cooperative timeout in the embedded Python runner. Expected to be killed by
# the timeout, never to return.

def validate(ctx):
    i = 0
    while True:
        i += 1
    return []
