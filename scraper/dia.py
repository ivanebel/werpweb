from vtex import scrape_vtex

DIA_URL = "https://diaonline.supermercadosdia.com.ar"


def scrape_dia(query):
    return scrape_vtex(DIA_URL, query)
