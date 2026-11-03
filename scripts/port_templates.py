"""
Regenerate content/templates/Template{Csv,Geo}.ipynb from the Renku session templates in
https://github.com/opendatazurich/opendatazurich_renku/tree/main/templates

The Lite templates are the Renku ones with network calls awaited, the helper
imported from opendata_lite (preloaded with the kernel, see jupyter-lite.json), the papermill
``stop-execution`` tag dropped, and a closing cell pointing to Renku sessions.
Every rewrite must match exactly once, so upstream changes fail loudly here
instead of silently producing a broken notebook.

    uv run python scripts/port_templates.py [--ref main]
"""

import argparse
import json
import urllib.request
from pathlib import Path

UPSTREAM = (
    "https://raw.githubusercontent.com/opendatazurich/opendatazurich_renku/{ref}/templates/{name}"
)
CONTENT = Path(__file__).resolve().parent.parent / "content" / "templates"

INTRO = """\
# OpenDataZurich starter notebook

This notebook runs **entirely in your browser** (JupyterLite with a Pyodide Python kernel): \
pandas, matplotlib, seaborn and the OpenDataZurich helper are preloaded \
when the kernel starts, and your changes are stored only in this browser. \
Run the cells from top to bottom with <kbd>Shift</kbd>+<kbd>Enter</kbd>, \
or use *Run → Run All Cells*."""

OUTRO = """\
## Need more power, or R?

This in-browser kernel is limited to the memory of your browser tab (a few GB at most) and \
cannot install packages with compiled code that are not part of Pyodide. \
For large datasets, other Python packages or for working in R, open the same dataset in a \
full Renku session:

* Python: <https://renkulab.io/p/opendatazurich/starter-code>
* R: <https://github.com/opendatazurich/opendatazurich_renku_r>

Use *File → Download* to keep a copy of this notebook."""

COMMON = [
    (
        "from src.opendata import OpenDataZurich\n",
        "from opendata_lite import OpenDataZurich\n",
    ),
    (
        "package = odz.get_package(name=package_id)",
        "package = await odz.get_package(name=package_id)",
    ),
    ("df = resource.df", "df = await resource.load()"),
]

GEO = [
    ("      resource.layers,\n", "      await resource.get_layers(),\n"),
    (
        '# df = resource.layer_df("insert-layer-name-here")',
        '# df = await resource.layer_df("insert-layer-name-here")',
    ),
    (
        'stadtkreise_package = odz.get_package(name="geo_stadtkreise")',
        'stadtkreise_package = await odz.get_package(name="geo_stadtkreise")',
    ),
    (
        'background_df = stadtkreise_resource.layer_df("adm_stadtkreise_a")',
        'background_df = await stadtkreise_resource.layer_df("adm_stadtkreise_a")',
    ),
]


def markdown(cell_id: str, text: str) -> dict:
    return {"cell_type": "markdown", "id": cell_id, "metadata": {}, "source": text}


def code(cell_id: str, text: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "id": cell_id,
        "metadata": {},
        "outputs": [],
        "source": text,
    }


def port(nb: dict, rewrites: list[tuple[str, str]]) -> dict:
    cells = nb["cells"]
    for old, new in rewrites:
        hits = [c for c in cells if old in "".join(c["source"])]
        if len(hits) != 1:
            raise SystemExit(f"expected exactly one cell containing {old!r}, found {len(hits)}")
        hits[0]["source"] = "".join(hits[0]["source"]).replace(old, new)
    for cell in cells:
        cell["source"] = "".join(cell["source"])
        tags = [t for t in cell["metadata"].get("tags", []) if t != "stop-execution"]
        if tags:
            cell["metadata"]["tags"] = tags
        else:
            cell["metadata"].pop("tags", None)
        if cell["cell_type"] == "code":
            cell["outputs"], cell["execution_count"] = [], None
    if not any("parameters" in c["metadata"].get("tags", []) for c in cells):
        raise SystemExit("template has no cell tagged 'parameters'")

    nb["cells"] = [markdown("lite-intro", INTRO), *cells]
    nb["cells"].append(markdown("lite-renku", OUTRO))
    nb["metadata"] = {
        "kernelspec": {"display_name": "Python (Pyodide)", "language": "python", "name": "python"},
        "language_info": {"name": "python"},
    }
    return nb


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    parser.add_argument("--ref", default="main", help="opendatazurich_renku git ref")
    args = parser.parse_args()
    for name, rewrites in (("TemplateCsv.ipynb", COMMON), ("TemplateGeo.ipynb", COMMON + GEO)):
        with urllib.request.urlopen(UPSTREAM.format(ref=args.ref, name=name)) as response:
            nb = json.load(response)
        out = CONTENT / name
        out.write_text(json.dumps(port(nb, rewrites), indent=1, ensure_ascii=False) + "\n")
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
