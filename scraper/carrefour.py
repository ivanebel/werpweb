import sys
from urllib.parse import quote

import requests

from vtex import HEADERS, REQUEST_TIMEOUT, parse_vtex_products

BASE_URL = "https://www.carrefour.com.ar"


def scrape_carrefour(query):
    url = f"{BASE_URL}/api/catalog_system/pub/products/search/{quote(query, safe='')}"
    headers = {**HEADERS, "Referer": f"{BASE_URL}/"}

    try:
        response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        print(f"Connection error at {BASE_URL}: {exc}", file=sys.stderr, flush=True)
        return []

    if response.status_code not in (200, 206):
        print(f"HTTP {response.status_code} at {BASE_URL}", file=sys.stderr, flush=True)
        return []

    try:
        data = response.json()
    except ValueError as exc:
        print(f"Invalid JSON from {BASE_URL}: {exc}", file=sys.stderr, flush=True)
        return []

    return parse_vtex_products(data, BASE_URL)
