"""Run against two disposable, annotated snapshots and an unmodified Git object store."""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

pilot = Path(__file__).resolve().parent
a, b, repo = map(Path.resolve, map(Path, sys.argv[1:]))
revision = '18dc6c3cd210343c7e741169038d5259c2932a50'
source = 'packages/plugin-contracts/src/index.ts'
symbols = ['PLUGIN_UI_PROTOCOL_VERSION', 'validateManifest']


def build(generator, checkout, output, error=None):
    run = subprocess.run(['node', generator, checkout, output], capture_output=True, text=True)
    if error:
        assert run.returncode and error in run.stderr, run.stderr
    else:
        run.check_returncode()


def baseline(file):
    return subprocess.check_output(['git', '-C', repo, 'show', revision + ':' + file], text=True).splitlines()


with tempfile.TemporaryDirectory() as directory:
    scratch = Path(directory)
    inputs = scratch / 'pilot'
    shutil.copytree(pilot, inputs, ignore=shutil.ignore_patterns('node_modules'))
    (inputs / 'node_modules').symlink_to(pilot / 'node_modules')
    first, second = scratch / 'first', scratch / 'second'
    build(pilot / 'generate.mjs', a, first)
    build(inputs / 'generate.mjs', b, second)
    for name in ['architecture.graph.json', 'module.md', 'decision.md', 'source-index.json']:
        assert (first / name).read_bytes() == (second / name).read_bytes()
        assert str(a) not in (first / name).read_text() and str(pilot) not in (first / name).read_text()
    graph = json.loads((first / 'architecture.graph.json').read_text())
    index = json.loads((first / 'source-index.json').read_text())
    assert [api['name'] for api in graph['apis']] == symbols
    for api in graph['apis']:
        assert api['file'] == source and api['name'] in baseline(source)[api['line'] - 1]
        expected = f"https://github.com/jt-jiangtao/action-driver/blob/{revision}/{source}#L{api['line']}"
        for page in ['module.md', 'decision.md']:
            assert '(' + expected + ')' in (first / page).read_text()
        item, = [i for i in index if (i['file'], i['symbol']) == (source, api['name'])]
        assert item['component'] == 'pluginContracts' and item['decisions'] == ['decision.md']
        assert item['module'] == 'module.md#' + api['name'].lower()
        assert '### ' + api['name'] in (first / 'module.md').read_text()
    assert not any(i['symbol'] == 'PLUGIN_SDK_VERSION' for i in index)
    for case in graph['decision']['tests']:
        assert case['name'] in baseline(case['file'])[case['line'] - 1]
    src = b / source
    original = src.read_text()
    try:
        src.write_text('\n\n' + original)
        build(inputs / 'generate.mjs', b, second)
        moved = json.loads((second / 'architecture.graph.json').read_text())
        assert len(graph['apis']) == len(moved['apis'])
        for old, new in zip(graph['apis'], moved['apis']):
            assert old['id'] == new['id'] and old['line'] + 2 == new['line']
        assert moved['decision']['id'] == graph['decision']['id'] and moved['component']['id'] == graph['component']['id']
        src.write_text(original.replace('@architecture pluginContracts', '@architecture missingComponent'))
        build(inputs / 'generate.mjs', b, second, 'unknown @architecture missingComponent')
    finally:
        src.write_text(original)
    adr = inputs / 'ui-protocol.md'
    adr.write_text(adr.read_text().replace('#validateManifest', '#missingApi'))
    build(inputs / 'generate.mjs', b, second, 'ui-protocol.md unknown affectedApis reference @action-driver/plugin-contracts#missingApi')
print('PASS: four source links, two reverse lookups, untagged control, test locations, two roots, line drift and both invalid references')
