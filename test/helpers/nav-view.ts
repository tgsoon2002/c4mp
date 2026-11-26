import * as fs from 'fs';
import * as path from 'path';
import type { ViewModel } from '../../src/types';

// P20-T5-0 (b254): sample data for the IO-view tests. test/fixtures/nav-view/sample.json is a complete ViewModel
// (arch root + nav + navView); wave-1 tasks never edit it, they derive variants in memory with these helpers.

/** A deep copy of the sample ViewModel (mutate it freely). */
export function loadSample(): ViewModel {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'nav-view', 'sample.json'), 'utf8')) as ViewModel;
}

/** A deep copy of `sample` whose root/edges are replaced by navView.root/navView.edges (nav and navView kept): a pure io page. */
export function ioModel(sample: ViewModel): ViewModel {
  if (!sample.navView) throw new Error('ioModel: the model has no navView');
  const copy = JSON.parse(JSON.stringify(sample)) as ViewModel;
  copy.root = copy.navView!.root;
  copy.edges = copy.navView!.edges;
  return copy;
}
