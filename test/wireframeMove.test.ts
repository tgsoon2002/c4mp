import * as fs from 'fs';
import * as path from 'path';
import { parsePlanTexts } from '../src/plan/parser';
import { fqnMapOf } from '../src/c4/planMove';
import { planWireframeMoves } from '../src/c4/wireframeMove';
import type { FqnMap, Plan } from '../src/types';

// MV-2 (PLAN_MOVE.md 1.3, 7.2): wireframe files follow plan move / rename. Fixture io-shop: screen shop.web.home has a file.
const DIR = path.join(__dirname, 'fixtures', 'io-shop', 'c4');
const SHOP = fs.readFileSync(path.join(DIR, 'shop.c4'), 'utf8');
const HOME_HTML = fs.readFileSync(path.join(DIR, 'io', 'shop.web.home.html'), 'utf8');
const FILE = 'c4/io/shop.web.home.html';
const parse = (text: string): Plan => parsePlanTexts('/r', new Map([['c4/shop.c4', text]]));
const BEFORE = parse(SHOP);

/** Old -> new of the roots and every descendant, in the plan before the move (MV-1's fqnMapOf). */
const mapOf = (roots: [string, string][]): FqnMap => fqnMapOf(BEFORE, roots);

/** Replace one exact piece of the shop text (asserts it is there). */
function edit(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

const HOME_HEADER = "      home = screen 'Home' {\n        header = region 'Header' {\n          logo = control 'Logo'\n          search = control 'Search box'\n        }\n        hero = region 'Hero banner' {\n";
const SHOP_NOW = "          shop_now = control 'Shop now button' {\n            -> shop.web.products 'Shop now'\n          }\n";

const renamed = edit(edit(SHOP, "home = screen 'Home'", "start = screen 'Home'"), '-> shop.web.home ', '-> shop.web.start ');
const searchToHero = edit(SHOP, HOME_HEADER,
  "      home = screen 'Home' {\n        header = region 'Header' {\n          logo = control 'Logo'\n        }\n        hero = region 'Hero banner' {\n          search = control 'Search box'\n");
const shopNowOut = edit(edit(SHOP, SHOP_NOW, ''), "          pager = control 'Pager'\n", "          pager = control 'Pager'\n" + SHOP_NOW);

const dotted = edit(HOME_HTML, 'data-c4="search"', 'data-c4="header.search"');
const SEARCH = mapOf([['shop.web.home.header.search', 'shop.web.home.hero.search']]);

describe('planWireframeMoves', () => {
  it.each<[string, string, string, FqnMap, object]>([
    ['screen renamed: file name only', HOME_HTML, renamed, mapOf([['shop.web.home', 'shop.web.start']]),
      { edits: [{ from: FILE, to: 'c4/io/shop.web.start.html', oldText: HOME_HTML, newText: HOME_HTML }], mentions: [] }],
    ['part moved inside its screen: a dotted ref is rewritten', dotted, searchToHero, SEARCH,
      { edits: [{ from: FILE, to: FILE, oldText: dotted, newText: edit(dotted, 'data-c4="header.search"', 'data-c4="hero.search"') }], mentions: [] }],
    ['part moved inside its screen: a unique bare id stays', HOME_HTML, searchToHero, SEARCH, { edits: [], mentions: [] }],
    ['part moved to another screen: listed, not edited', HOME_HTML, shopNowOut, mapOf([['shop.web.home.hero.shop_now', 'shop.web.products.results.shop_now']]),
      { edits: [], mentions: [{ file: FILE, line: 15, ref: 'shop_now', reason: 'left-screen' }] }],
    ['ref written with an entity: listed, not edited', edit(HOME_HTML, 'data-c4="search"', 'data-c4="header&#46;search"'), searchToHero, SEARCH,
      { edits: [], mentions: [{ file: FILE, line: 12, ref: 'header.search', reason: 'encoded' }] }],
  ])('%s', (_name, html, afterText, m, expected) => {
    const r = planWireframeMoves(new Map([['shop.web.home', { file: FILE, text: html }]]), BEFORE, parse(afterText), m, () => false);
    expect(r).toEqual({ ok: true, ...expected });
  });

  it('a screen whose new file name is taken is refused', () => {
    const r = planWireframeMoves(new Map([['shop.web.home', { file: FILE, text: HOME_HTML }]]), BEFORE, parse(renamed),
      mapOf([['shop.web.home', 'shop.web.start']]), f => f === 'c4/io/shop.web.start.html');
    expect(r).toEqual({ ok: false, problems: ['wireframe collision: io/shop.web.start.html exists'] });
  });
});
