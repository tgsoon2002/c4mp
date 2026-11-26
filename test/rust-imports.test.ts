import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { rustHandler } from '../src/languages/rust';
import { extractRustImports } from '../src/languages/rust/imports';
import { createRustResolver } from '../src/languages/rust/resolve';

const parseRust = (code: string) => rustHandler.parse(code, '');

const specs = (code: string) => extractRustImports(parseRust(code)).map((i) => i.spec);

describe('Rust import extraction', () => {
  it('flattens use trees, drops aliases, keeps crate/self/super and leading ::', () => {
    const code = [
      'use std::fmt;',
      'use crate::a::{b::{c, d}, e as f, g::*, self};',
      'use self::x::{y, z as w};',
      'use super::super::m::{self, n};',
      'use ::foo::bar;',
      'use a::b::*;',
      'use {p, q};',
      'pub use crate::h;',
      'extern crate serde;',
      'extern crate old as new;',
    ].join('\n');
    expect(specs(code)).toEqual([
      'std::fmt',
      'crate::a',
      'crate::a::b::c',
      'crate::a::b::d',
      'crate::a::e',
      'crate::a::g',
      'self::x::y',
      'self::x::z',
      'super::super::m',
      'super::super::m::n',
      '::foo::bar',
      'a::b',
      'p',
      'q',
      'crate::h',
      'serde',
      'old',
    ]);
  });

  it('reports mod x; with its inline module chain and ignores inline modules', () => {
    const code = 'mod a;\npub mod b { pub mod c; mod d { mod e; } fn f() {} }\nmod inline { fn g() {} }\n';
    expect(specs(code)).toEqual(['mod a', 'mod b::c', 'mod b::d::e']);
  });

  it('rewrites self/super used inside inline modules relative to the file', () => {
    const code = [
      'mod tests {',
      '  use super::*;',
      '  use super::helper;',
      '  use self::inner::X;',
      '  mod deep { use super::super::top; use super::sib; }',
      '}',
    ].join('\n');
    expect(specs(code)).toEqual(['self::helper', 'self::tests::inner::X', 'self::tests::sib', 'self::top']);
  });
});

function tree(files: Record<string, string>): { root: string; sources: string[]; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-resolve-'));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), content);
  }
  const sources = Object.keys(files).filter((f) => f.endsWith('.rs'));
  return { root, sources, done: () => fs.rmSync(root, { recursive: true }) };
}

describe('Rust import resolution on the rustshop fixture', () => {
  const root = path.join(__dirname, 'fixtures/rustshop');
  const sources = ['src/lib.rs', 'src/shop.rs', 'src/util/mod.rs', 'src/util/fmt.rs'];
  const resolve = createRustResolver(root, sources, rustHandler.parse);
  const all = sources.flatMap((file) =>
    extractRustImports(parseRust(fs.readFileSync(path.join(root, file), 'utf8'))).map((i) => ({ file, spec: i.spec, ...resolve(file, i.spec) })));

  it('resolves every import, none unresolved', () => {
    expect(all.filter((r) => r.status === 'unresolved')).toEqual([]);
    expect(all.filter((r) => r.status === 'internal').length).toBe(11);
    expect(all.filter((r) => r.status === 'external').map((r) => r.pkg).sort()).toEqual(['serde', 'std', 'std']);
  });

  it('maps mod, crate::, super:: and bare local module paths to files', () => {
    const target = (file: string, spec: string) => resolve(file, spec).target;
    expect(target('src/lib.rs', 'mod shop')).toBe('src/shop.rs');
    expect(target('src/lib.rs', 'mod util')).toBe('src/util/mod.rs');
    expect(target('src/util/mod.rs', 'mod fmt')).toBe('src/util/fmt.rs');
    expect(target('src/lib.rs', 'crate::shop::make_order')).toBe('src/shop.rs');
    expect(target('src/lib.rs', 'shop::tax')).toBe('src/shop.rs');
    expect(target('src/util/fmt.rs', 'super::helper')).toBe('src/util/mod.rs');
    expect(target('src/util/fmt.rs', 'crate::util::helper')).toBe('src/util/mod.rs');
    expect(target('src/util/fmt.rs', 'crate')).toBe('src/lib.rs');
    // `use Align::*;` of an enum declared in the same file (fd: `use Token::*`)
    expect(target('src/util/fmt.rs', 'Align')).toBe('src/util/fmt.rs');
  });
});

describe('Rust import resolution on temp trees', () => {
  it('handles a Cargo workspace: member crates are internal, other crates external', () => {
    const t = tree({
      'Cargo.toml': '[workspace]\nmembers = ["core-lib", "app"]\n',
      'core-lib/Cargo.toml': '[package]\nname = "core-lib"\nversion = "0.1.0"\n',
      'core-lib/src/lib.rs': 'pub mod model;\n',
      'core-lib/src/model.rs': '',
      'app/Cargo.toml': '[package]\nname = "app"\n\n[dependencies]\nname = "ignored"\n',
      'app/src/main.rs': 'mod cli;\n',
      'app/src/cli.rs': '',
    });
    try {
      const r = createRustResolver(t.root, t.sources, rustHandler.parse);
      expect(r('app/src/cli.rs', 'core_lib::model::Thing')).toEqual({ status: 'internal', target: 'core-lib/src/model.rs' });
      expect(r('app/src/cli.rs', 'core_lib')).toEqual({ status: 'internal', target: 'core-lib/src/lib.rs' });
      expect(r('app/src/cli.rs', '::core_lib::model')).toEqual({ status: 'internal', target: 'core-lib/src/model.rs' });
      expect(r('app/src/cli.rs', 'clap::Parser')).toEqual({ status: 'external', pkg: 'clap' });
      expect(r('app/src/cli.rs', 'crate')).toEqual({ status: 'internal', target: 'app/src/main.rs' });
      expect(r('app/src/main.rs', 'mod cli')).toEqual({ status: 'internal', target: 'app/src/cli.rs' });
    } finally {
      t.done();
    }
  });

  it('follows non-mod.rs module folders, super chains and inline-module files', () => {
    const t = tree({
      'src/lib.rs': 'mod a;\n',
      'src/a.rs': 'mod b;\n',
      'src/a/b.rs': 'mod c;\n',
      'src/a/b/c.rs': '',
      'src/a/inl.rs': '',
      'src/bin/tool.rs': 'mod helper;\n',
      'src/bin/helper.rs': '',
    });
    try {
      const r = createRustResolver(t.root, t.sources, rustHandler.parse);
      expect(r('src/a.rs', 'mod b').target).toBe('src/a/b.rs');
      expect(r('src/a/b.rs', 'mod c').target).toBe('src/a/b/c.rs');
      expect(r('src/a/b/c.rs', 'super::super::X').target).toBe('src/a.rs');
      expect(r('src/a/b/c.rs', 'super::super::super::X').target).toBe('src/lib.rs');
      expect(r('src/a/b/c.rs', 'crate::a::b::c::Item').target).toBe('src/a/b/c.rs');
      expect(r('src/a.rs', 'mod outer::inl').target).toBeUndefined();
      expect(r('src/lib.rs', 'mod a::inl').target).toBe('src/a/inl.rs');
      expect(r('src/bin/tool.rs', 'mod helper').target).toBe('src/bin/helper.rs');
      expect(r('src/bin/helper.rs', 'crate').target).toBe('src/bin/helper.rs');
    } finally {
      t.done();
    }
  });

  it('a bare first segment naming a type-namespace item of the same file is that file', () => {
    const t = tree({
      'src/lib.rs': [
        'pub mod m { pub enum E { A } }',
        'fn regex() {}',
        'struct S;',
        'impl S { type Q = u32; }',
        'fn f() { enum Local { B } use Local::*; use m::E; use E::*; use regex::Regex; use Q::x; }',
      ].join('\n'),
    });
    try {
      const r = createRustResolver(t.root, t.sources, rustHandler.parse);
      expect(r('src/lib.rs', 'Local')).toEqual({ status: 'internal', target: 'src/lib.rs' });   // enum in a fn body
      expect(r('src/lib.rs', 'm::E')).toEqual({ status: 'internal', target: 'src/lib.rs' });    // inline module
      expect(r('src/lib.rs', 'E')).toEqual({ status: 'internal', target: 'src/lib.rs' });       // enum in an inline module
      expect(r('src/lib.rs', 'S')).toEqual({ status: 'internal', target: 'src/lib.rs' });       // struct
      expect(r('src/lib.rs', 'regex::Regex')).toEqual({ status: 'external', pkg: 'regex' });    // a fn is not a path start
      expect(r('src/lib.rs', 'Q::x')).toEqual({ status: 'external', pkg: 'Q' });                // impl associated type
    } finally {
      t.done();
    }
  });

  it('reports unresolved for a missing module file or super beyond the crate root', () => {
    const t = tree({ 'src/lib.rs': '', 'src/x.rs': '' });
    try {
      const r = createRustResolver(t.root, t.sources, rustHandler.parse);
      expect(r('src/lib.rs', 'mod missing')).toEqual({ status: 'unresolved', reason: 'module file not found' });
      expect(r('src/lib.rs', 'super::x')).toEqual({ status: 'unresolved', reason: 'super above the crate root' });
      expect(r('src/x.rs', 'super::super::y')).toEqual({ status: 'unresolved', reason: 'super above the crate root' });
    } finally {
      t.done();
    }
  });
});
