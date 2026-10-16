"""
--out FILE for the scripts that print their report: what they print is also
written to FILE. The tracked outputs the docs and code comments cite live in
docs/evidence/ (index: docs/evidence/README.md), e.g. from backend/:

    python -m scripts.evaluate_forecast --out ../docs/evidence/evaluate_forecast.txt
"""
import contextlib
import sys


def pop_out(argv):
    """(the path after --out or None, argv without the option)."""
    if '--out' in argv:
        i = argv.index('--out')
        if i + 1 >= len(argv):
            raise SystemExit('--out needs a file name')
        return argv[i + 1], argv[:i] + argv[i + 2:]
    return None, list(argv)


class _Tee:
    def __init__(self, *streams):
        self.streams = streams

    def write(self, text):
        for stream in self.streams:
            stream.write(text)
        return len(text)

    def flush(self):
        for stream in self.streams:
            stream.flush()


@contextlib.contextmanager
def tee_stdout(path):
    """Print as usual and, when path is given, write the same text to it."""
    if not path:
        yield
        return
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        saved = sys.stdout
        sys.stdout = _Tee(saved, fh)
        try:
            yield
        finally:
            sys.stdout = saved
