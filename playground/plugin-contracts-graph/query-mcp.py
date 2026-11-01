"""Issue a real MCP read-element call and print the portable fields from its response."""
import json
import subprocess
from pathlib import Path

pilot = Path(__file__).resolve().parent
process = subprocess.Popen([pilot / 'node_modules/.bin/likec4', 'mcp', '--stdio', '.'],
                           cwd=pilot, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)


def send(message):
    process.stdin.write(json.dumps({'jsonrpc': '2.0', **message}) + '\n')
    process.stdin.flush()


def request(number, method, params):
    send({'id': number, 'method': method, 'params': params})
    for line in process.stdout:
        response = json.loads(line)
        if response.get('id') == number:
            return response['result']
    raise RuntimeError('LikeC4 MCP closed its output')


try:
    server = request(1, 'initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                      'clientInfo': {'name': 'architecture-kit-pilot', 'version': '1'}})['serverInfo']
    send({'method': 'notifications/initialized'})
    assert 'read-element' in [tool['name'] for tool in request(2, 'tools/list', {})['tools']]
    params = {'name': 'read-element', 'arguments': {'id': 'pluginContracts'}}
    element = request(3, 'tools/call', params)['structuredContent']
    assert element['id'] == 'pluginContracts' and element['kind'] == 'component'
    result = {key: element[key] for key in ['id', 'title', 'kind', 'description', 'includedInViews']}
    print(json.dumps({'server': server, 'request': params, 'element': result}, indent=2))
finally:
    process.terminate()
    process.wait(timeout=10)
