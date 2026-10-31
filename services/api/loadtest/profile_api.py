"""Run the API under yappi (wall and CPU time across every thread) and print where CPU goes.

LOAD_PROFILE=1 loadtest/start-api.sh   # then run locust; Ctrl-C (SIGINT) prints the top 40
"""

from __future__ import annotations

import os
import signal
import sys

import uvicorn
import yappi

yappi.set_clock_type("cpu")
yappi.start(builtins=False)


def _report(*_: object) -> None:
    yappi.stop()
    stats = yappi.get_func_stats()
    stats.sort("ttot", "desc")
    out = open(os.environ.get("LOAD_PROFILE_OUT", "/dev/stdout"), "w")
    stats.print_all(
        out=out, columns={0: ("name", 90), 1: ("ncall", 9), 3: ("ttot", 8), 4: ("tavg", 8)}
    )
    out.flush()
    sys.exit(0)


signal.signal(signal.SIGTERM, _report)
uvicorn.run(
    "app.main:app",
    host="127.0.0.1",
    port=int(os.environ.get("LOAD_API_PORT", 8200)),
    server_header=False,
)
_report()
