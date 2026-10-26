import json
import sys

from carrefour import scrape_carrefour
from dia import scrape_dia

SCRAPERS = (
    ("dia", scrape_dia),
    ("carrefour", scrape_carrefour),
)


def configure_stdio():
    """Force UTF-8 so product names work on Windows consoles and from Node."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def main():
    query = " ".join(" ".join(sys.argv[1:]).split())
    if not query:
        print(
            json.dumps(
                {"error": "Debe ingresar un texto a buscar como parámetro"},
                ensure_ascii=False,
            )
        )
        return 2

    results = {"query": query}
    for key, scraper in SCRAPERS:
        try:
            results[key] = scraper(query)
        except Exception as exc:
            # Diagnostics must go to stderr. stdout is reserved for JSON.
            print(f"{key}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            results[key] = []

    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    configure_stdio()
    raise SystemExit(main())
