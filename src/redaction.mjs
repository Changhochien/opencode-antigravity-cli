// Incremental, bounded credential recognition. Only a possible prefix (at most
// 24 characters) is held; ordinary text and whitespace can stream immediately.
const labels = ['apikey', 'api_key', 'api-key', 'accesstoken', 'access_token', 'access-token', 'password', 'authorization']
const rules = [
  ...labels.map(prefix => ({ prefix, kind: 'label', insensitive: true })),
  { prefix: 'bearer', kind: 'bearer', insensitive: true },
  ...['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'].map(prefix => ({ prefix, kind: 'token', min: 1, chars: /\w/ })),
  { prefix: 'sk-', kind: 'token', min: 16, chars: /[\w-]/ },
  { prefix: 'AIza', kind: 'token', min: 20, chars: /[\w-]/ },
]
const bearerChars = /[\w.+/=-]/
const valueChars = /[^\s,;]/

/** @param {(text: string) => void} emit */
export function createRedactor(emit) {
  let pending = '', previous = '', mode = 'text', output = '', token, count = 0, valueWord = ''
  let drop = valueChars
  function send(text) {
    output += text
    if (output.length >= 8192) drain()
  }
  function drain() { if (output) emit(output); output = '' }
  function scan(char) {
    if (!pending && !/[aApPbBgGsS]/.test(char)) { send(char); previous = char; return }
    pending += char
    while (pending) {
      const possible = rules.filter(rule => (rule.kind !== 'token' || !/\w/.test(previous))
        && rule.prefix.startsWith(rule.insensitive ? pending.toLowerCase() : pending))
      const match = possible.find(rule => rule.prefix.length === pending.length)
      if (match) {
        previous = pending.at(-1)
        if (match.kind === 'token') { token = match; count = 0; mode = 'probe' }
        else { send(pending); pending = ''; mode = match.kind }
        return
      }
      if (possible.length) return
      send(pending[0]); previous = pending[0]; pending = pending.slice(1)
    }
  }
  function consume(char) {
    if (mode === 'probe') {
      if (token.chars.test(char)) {
        pending += char; previous = char
        if (++count >= token.min) { send('[redacted]'); pending = ''; drop = token.chars; valueWord = ''; mode = 'drop' }
        return
      }
      // A short lookalike is ordinary text. Rescan its suffix so embedded labels
      // such as sk-password=... are still recognized.
      const literal = pending
      pending = ''; mode = 'text'; send(literal[0]); previous = literal[0]
      for (const part of literal.slice(1) + char) consume(part)
      return
    }
    if (mode === 'drop') {
      if (drop.test(char)) {
        if (valueWord && valueWord.length <= 6) valueWord += char.toLowerCase()
        previous = char; return
      }
      mode = valueWord === 'bearer' && /\s/.test(char) ? 'bearerValue' : 'text'
      valueWord = ''
    }
    if (mode === 'label' || mode === 'bearer') {
      if (/\s/.test(char)) {
        if (mode === 'bearer') mode = 'bearerValue'
        send(char); previous = char; return
      }
      if (mode === 'label' && /[:=]/.test(char)) { send(char); previous = char; mode = 'value'; return }
      mode = 'text'
    }
    if (mode === 'value' || mode === 'bearerValue') {
      if (/\s/.test(char)) { send(char); previous = char; return }
      drop = mode === 'value' ? valueChars : bearerChars
      if (drop.test(char)) {
        valueWord = mode === 'value' ? char.toLowerCase() : ''
        send('[redacted]'); previous = char; mode = 'drop'; return
      }
      mode = 'text'
    }
    scan(char)
  }
  return {
    write(text) { for (const char of text) consume(char); drain() },
    end() { send(pending); pending = ''; mode = 'text'; previous = ''; drain() },
  }
}

export function redact(value) {
  let output = ''
  const redactor = createRedactor(text => { output += text })
  redactor.write(String(value)); redactor.end()
  return output
}
