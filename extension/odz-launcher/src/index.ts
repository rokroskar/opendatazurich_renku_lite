/**
 * Open an OpenDataZurich starter notebook from URL parameters.
 *
 *   /lab/index.html?package_id=<ckan-name>[&resource_id=<uuid>]
 *
 * This replaces the papermill step of the Renku session launcher
 * (post-init.sh + run_template.py): pick the CSV or geo template from the
 * package's CKAN metadata, inject the `parameters` cell and open the result.
 * The notebook is stored in the visitor's browser only; nothing runs until
 * the visitor runs it.
 */
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { showErrorMessage } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { Contents } from '@jupyterlab/services';

const CKAN_API = 'https://data.stadt-zuerich.ch/api/3/action';
const TEMPLATES = {
  csv: 'templates/TemplateCsv.ipynb',
  geo: 'templates/TemplateGeo.ipynb'
};
const PACKAGE_ID = /^[a-z0-9_-]{1,200}$/;
const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Session launchers for the opendatazurich/starter-code Renku project.
// Update these if the launchers are recreated on renkulab.io.
const RENKU_PYTHON_SESSION = '01KC1K2SN2GAQSGJ3NY602EA95';
const RENKU_R_SESSION = '01K7HKDF1S55RHSZPCK4SHTX1H';

interface ILaunchParams {
  packageId: string;
  resourceId: string | null;
}

interface ICkanResource {
  url?: string;
  format?: string;
}

/** Validated launch parameters, null when absent; throws when invalid. */
export function parseParams(search: string): ILaunchParams | null {
  const params = new URLSearchParams(search);
  const packageId = params.get('package_id');
  if (packageId === null) {
    return null;
  }
  const resourceId = params.get('resource_id') || null;
  if (!PACKAGE_ID.test(packageId)) {
    throw new Error(`Invalid package_id: ${JSON.stringify(packageId)}`);
  }
  if (
    resourceId !== null &&
    resourceId.toUpperCase() !== 'NONE' &&
    !RESOURCE_ID.test(resourceId)
  ) {
    throw new Error(`Invalid resource_id: ${JSON.stringify(resourceId)}`);
  }
  return {
    packageId,
    resourceId: resourceId?.toUpperCase() === 'NONE' ? null : resourceId
  };
}

/** Same rule as get_dataset_type.py / opendata_lite.dataset_type. */
export function datasetType(resources: ICkanResource[]): 'geo' | 'csv' {
  if (resources.some(r => (r.url ?? '').includes('geojson'))) {
    return 'geo';
  }
  return 'csv';
}

/** Python source for the `parameters` cell (JSON strings are valid Python literals). */
export function parametersSource({ packageId, resourceId }: ILaunchParams): string {
  return [
    `package_id = ${JSON.stringify(packageId)}`,
    `resource_id = ${resourceId === null ? 'None' : JSON.stringify(resourceId)}`
  ].join('\n');
}

/** Markdown source for the closing "Need more power?" cell with pre-filled session links. */
export function renkuLinksSource({ packageId, resourceId }: ILaunchParams): string {
  const qs = new URLSearchParams({ PACKAGE_ID: packageId });
  if (resourceId !== null) {
    qs.set('RESOURCE_ID', resourceId);
  }
  const pyUrl = `https://renkulab.io/p/opendatazurich/starter-code/sessions/${RENKU_PYTHON_SESSION}/start?${qs}`;
  const rUrl = `https://renkulab.io/p/opendatazurich/starter-code/sessions/${RENKU_R_SESSION}/start?${qs}`;
  return [
    '## Need more power, or R?',
    '',
    'This in-browser kernel is limited to the memory of your browser tab (a few GB at most) and cannot install packages with compiled code that are not part of Pyodide. For large datasets, other Python packages or for working in R, open this dataset in a full Renku session:',
    '',
    `* [Open in Renku (Python)](${pyUrl})`,
    `* [Open in Renku (R)](${rUrl})`,
    '',
    'Use *File → Download* to keep a copy of this notebook.'
  ].join('\n');
}

function notebookPath({ packageId, resourceId }: ILaunchParams): string {
  const suffix = resourceId === null ? '' : `--${resourceId.slice(0, 8)}`;
  return `OpenData-${packageId}${suffix}.ipynb`;
}

async function exists(contents: Contents.IManager, path: string): Promise<boolean> {
  try {
    await contents.get(path, { content: false });
    return true;
  } catch {
    return false;
  }
}

async function fetchResources(packageId: string): Promise<ICkanResource[]> {
  const url = `${CKAN_API}/package_show?id=${encodeURIComponent(packageId)}`;
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new Error(
      `Dataset "${packageId}" was not found in the OpenDataZurich catalogue (HTTP ${response.status}).`
    );
  }
  return body.result.resources ?? [];
}

async function createNotebook(
  contents: Contents.IManager,
  params: ILaunchParams,
  path: string
): Promise<void> {
  const template = TEMPLATES[datasetType(await fetchResources(params.packageId))];
  const model = await contents.get(template, { content: true, type: 'notebook' });
  const notebook = model.content;
  const cell = notebook.cells.find((c: any) =>
    (c.metadata?.tags ?? []).includes('parameters')
  );
  if (cell === undefined) {
    throw new Error(`${template} has no cell tagged "parameters".`);
  }
  cell.source = parametersSource(params);
  const renkuLinksCell = notebook.cells.find((c: any) => c.id === 'lite-renku');
  if (renkuLinksCell === undefined) {
    throw new Error(`${template} has no cell with id "lite-renku".`);
  }
  renkuLinksCell.source = renkuLinksSource(params);
  await contents.save(path, { type: 'notebook', format: 'json', content: notebook });
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'odz-launcher:plugin',
  description: 'Open an OpenDataZurich starter notebook from ?package_id=&resource_id=',
  autoStart: true,
  requires: [IDocumentManager],
  activate: (app: JupyterFrontEnd, docManager: IDocumentManager) => {
    let params: ILaunchParams | null;
    try {
      params = parseParams(window.location.search);
    } catch (error) {
      void app.restored.then(() => showErrorMessage('Cannot open dataset', error as Error));
      return;
    }
    if (params === null) {
      return;
    }
    const launch = params;
    void app.restored
      .then(async () => {
        const contents = app.serviceManager.contents;
        const path = notebookPath(launch);
        // A returning visitor keeps their edited copy.
        if (!(await exists(contents, path))) {
          await createNotebook(contents, launch, path);
        }
        docManager.openOrReveal(path);
        // Drop the parameters so a reload does not repeat the launch.
        const url = new URL(window.location.href);
        url.searchParams.delete('package_id');
        url.searchParams.delete('resource_id');
        window.history.replaceState(null, '', url.toString());
      })
      .catch(error => showErrorMessage('Cannot open dataset', error as Error));
  }
};

export default plugin;
