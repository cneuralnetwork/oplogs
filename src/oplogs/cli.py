"""Human-readable OPLOGS command line interface."""

from __future__ import annotations

import json
import subprocess
import sys
import webbrowser
from contextlib import suppress
from pathlib import Path
from typing import Annotated

import httpx
import typer

from .config import data_dir, read_daemon_info
from .process import ensure_daemon, stop_daemon
from .storage import Storage

app = typer.Typer(
    no_args_is_help=True, help="Local experiment tracking without an account or cloud service."
)


@app.command()
def open(run_id: str | None = typer.Argument(default=None)) -> None:
    """Open the local dashboard or a specific run."""
    daemon, _ = ensure_daemon(open_browser=False)
    url = f"{daemon.url}/runs/{run_id}" if run_id else daemon.url
    webbrowser.open(url)
    typer.echo(url)


@app.command()
def stop() -> None:
    """Stop the persistent local daemon without deleting data."""
    typer.echo("Stopped OPLOGS." if stop_daemon() else "OPLOGS is not running.")


@app.command()
def doctor() -> None:
    """Inspect daemon, storage, and optional integration readiness."""
    daemon = read_daemon_info()
    healthy = False
    if daemon:
        with suppress(httpx.HTTPError):
            healthy = httpx.get(f"{daemon.url}/health", timeout=1).status_code == 200
    storage = Storage().storage_usage()
    typer.echo("OPLOGS doctor")
    typer.echo(f"  daemon: {'healthy' if healthy else 'stopped'}")
    typer.echo(f"  data:   {storage['root']}")
    typer.echo(f"  runs:   {storage['runs']}")
    typer.echo(f"  size:   {storage['bytes'] / 1024**2:.2f} MiB")
    typer.echo(f"  python: {sys.version.split()[0]}")


@app.command("storage")
def storage_command() -> None:
    """Show retained local data usage. OPLOGS never auto-deletes runs."""
    value = Storage().storage_usage()
    typer.echo(json.dumps(value, indent=2))


@app.command()
def rebuild() -> None:
    """Rebuild indexes from canonical checksummed run journals."""
    typer.echo(json.dumps(Storage().rebuild(), indent=2))


@app.command("alert")
def create_alert_command(
    project: str | None = typer.Option(default=None),
    event: str | None = typer.Option(default=None),
    metric: str | None = typer.Option(default=None),
    operator: str = typer.Option(default=">"),
    threshold: float = typer.Option(default=0),
    message: str | None = typer.Option(default=None),
    webhook: str | None = typer.Option(default=None),
    command: Annotated[list[str] | None, typer.Option()] = None,
    desktop: bool = typer.Option(default=True),
) -> None:
    """Create a local desktop, command, or webhook alert rule."""
    if operator not in {">", "<"}:
        raise typer.BadParameter("operator must be > or <")
    if not event and not metric:
        raise typer.BadParameter("set --event or --metric")
    rule: dict[str, object] = {"desktop": desktop, "operator": operator, "threshold": threshold}
    for key, value in {
        "event": event,
        "metric": metric,
        "message": message,
        "webhook": webhook,
        "command": command,
    }.items():
        if value is not None:
            rule[key] = value
    typer.echo(json.dumps(Storage().create_alert(project, rule), indent=2))


@app.command()
def server(port: int = typer.Option(default=7437)) -> None:
    """Run the daemon in the foreground for development."""
    from .config import new_token

    subprocess.run(
        [sys.executable, "-m", "oplogs.daemon", "--port", str(port), "--token", new_token()],
        check=False,
    )


@app.command("export")
def export_data(destination: Path, run_id: str | None = None) -> None:
    """Export OPLOGS data as a portable directory."""
    import shutil

    source = data_dir() / "runs" / run_id if run_id else data_dir()
    if not source.exists():
        raise typer.BadParameter(f"not found: {source}")
    destination = destination.resolve()
    if destination.exists():
        raise typer.BadParameter("destination already exists")
    shutil.copytree(source, destination)
    typer.echo(str(destination))


@app.command("import-wandb")
def import_wandb_command(source: Path, project: str | None = None) -> None:
    """Import a W&B export directory or portable JSON file."""
    from .importer import import_wandb

    typer.echo(json.dumps(import_wandb(source, project=project), indent=2))


@app.command("sweep")
def sweep_command(
    config: Path,
    command: Annotated[list[str], typer.Argument(help="Training command and arguments")],
) -> None:
    """Run a grid, random, or Bayesian-style local subprocess sweep."""
    from .sweeps import SweepController, load_sweep

    result = SweepController(load_sweep(config), command).run()
    typer.echo(json.dumps(result, indent=2))


@app.command("report-export")
def report_export(report_id: str, destination: Path, pdf: bool = False) -> None:
    """Export a local report to self-contained HTML or PDF."""
    from .reports import export_pdf, render_report

    report = next((item for item in Storage().reports() if item["id"] == report_id), None)
    if not report:
        raise typer.BadParameter("report not found")
    if pdf:
        temporary = destination.with_suffix(".html")
        render_report(report, temporary)
        export_pdf(temporary, destination)
        temporary.unlink(missing_ok=True)
    else:
        render_report(report, destination)
    typer.echo(str(destination.resolve()))


if __name__ == "__main__":
    app()
