import { describe, it, expect } from 'vitest'
import { $iq } from 'strophe.js'
import { createNamespacedElement, valueToXml } from '../pyobs-codec'

// Regression test for a real bug: createNamespacedElement used createElementNS
// alone, which sets the DOM's internal namespaceURI but does NOT add a
// serializable xmlns attribute. Strophe's Builder.serialize() is a hand-rolled
// string serializer that only emits attributes literally present in
// el.attributes — it never reads namespaceURI. So the inner
// <value xmlns="urn:pyobs:rpc:1"> RPC-param wrapper went out on the wire with
// no namespace declaration at all, silently inheriting the ambient
// jabber:iq:rpc namespace instead. Server-side, xml_to_params looks up a
// urn:pyobs:rpc:1-namespaced child specifically, doesn't find one, and
// appends None for the param — regardless of what value was actually sent.
// pyobs-codec.spec.ts's round-trip tests didn't catch this because they call
// xmlToValue directly on the in-memory DOM object valueToXml returns, never
// serializing to text through Strophe the way a real RPC call does.
describe('createNamespacedElement + Strophe serialization', () => {
  it('emits an explicit xmlns attribute that survives Strophe.Builder.toString()', () => {
    const wrapper = createNamespacedElement('urn:pyobs:rpc:1', 'value')
    expect(wrapper.getAttribute('xmlns')).toBe('urn:pyobs:rpc:1')
  })

  it('round-trips through an actual RPC call stanza the way executeMethod builds one', () => {
    const contentEl = valueToXml(1, 'int32')
    const pyobsValue = createNamespacedElement('urn:pyobs:rpc:1', 'value')
    pyobsValue.appendChild(contentEl)

    const builder = $iq({ to: 'camera@localhost/pyobs', type: 'set' })
      .c('query', { xmlns: 'jabber:iq:rpc' })
      .c('methodCall')
      .c('methodName')
      .t('set_binning')
      .up()
      .c('params')
    builder.c('param').c('value').cnode(pyobsValue).up().up().up()

    const xml = builder.toString()
    expect(xml).toContain('<value xmlns="urn:pyobs:rpc:1"><int>1</int></value>')
  })
})
