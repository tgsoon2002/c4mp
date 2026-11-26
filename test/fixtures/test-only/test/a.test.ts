import { onlyTested } from '../src/onlyTested';
import { makeThing } from './helpers';
export function caseA() { return [onlyTested(), makeThing()]; }
