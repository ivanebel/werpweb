import sys
from urllib.parse import quote

import requests

REQUEST_TIMEOUT = 30
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json",
}


def parse_vtex_products(data, base_url):
    """Turn a VTEX product-search payload into the flat format used by the UI."""
    if not isinstance(data, list):
        return []

    results = []
    for product in data:
        if not isinstance(product, dict):
            continue

        name = product.get("productName")
        link_text = product.get("linkText")
        price = None

        items = product.get("items")
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                sellers = item.get("sellers")
                if not isinstance(sellers, list):
                    continue
                for seller in sellers:
                    if not isinstance(seller, dict):
                        continue
                    offer = seller.get("commertialOffer")
                    if isinstance(offer, dict) and offer.get("Price") is not None:
                        price = offer["Price"]
                        break
                if price is not None:
                    break

        link = f"{base_url}/{link_text}/p" if link_text else None
        results.append({"title": name, "price": price, "link": link})

    return results


def scrape_vtex(base_url, query):
    """Scrape a VTEX store using its public product-search endpoint."""
    url = f"{base_url}/api/catalog_system/pub/products/search/{quote(query, safe='')}"
    headers = {**HEADERS, "Referer": f"{base_url}/"}

    try:
        response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        print(f"Connection error at {base_url}: {exc}", file=sys.stderr, flush=True)
        return []

    if response.status_code not in (200, 206):
        print(f"HTTP {response.status_code} at {base_url}", file=sys.stderr, flush=True)
        return []

    try:
        data = response.json()
    except ValueError as exc:
        print(f"Invalid JSON from {base_url}: {exc}", file=sys.stderr, flush=True)
        return []

    return parse_vtex_products(data, base_url)
