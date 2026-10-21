import { describe, expect, it, vi } from 'vitest';
import { observeInteractionContext, observeInteractionContextWithPrincipal, configuredGroupContext, type InteractionSession } from '../src/core/interaction-context.js';
import { parseInteractionContextCommand } from '../src/cli/interaction-context.js';
const session: InteractionSession = { sessionId: 's1', larkAppId: 'app1', status: 'active', chatId: 'oc_chat',
  scope: 'thread', rootMessageId: 'om_root', ownerOpenId: 'ou_owner', chatType: 'group' };
const request = { trustedHost: true, daemonAppId: 'app1', sessionId: 's1', body: { larkAppId: 'app1', actorOpenId: 'ou_owner' } };
describe('current host interaction context', () => {
  it('reads authoritative identity and current native talk decision without exposing data paths', () => {
    const talk = vi.fn(() => true);
    const result = observeInteractionContext({ ...request, body: { ...request.body, chatId: 'oc_forged', ownerOpenId: 'ou_forged' } },
      { findActive: () => ({ ...session, workingDir: '/private', token: 'secret' } as InteractionSession), canTalk: talk });
    expect(result.status).toBe(200);
    expect(result.body.context).toMatchObject({ chatId: 'oc_chat', ownerOpenId: 'ou_owner', rootMessageId: 'om_root', canTalk: true });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|forged/);
    expect(talk).toHaveBeenCalledWith('app1', 'oc_chat', 'ou_owner', 'group');
  });
  it.each([
    { chatId: 'doc:doc_token', scope: 'chat', rootMessageId: 'doc:doc_token' },
    { chatId: 'doc:doc_token', scope: 'chat', rootMessageId: 'om_doc_anchor' },
    ...['http_async_fixture', 'http_wait_fixture', 'headless_fixture'].map(chatId => ({ chatId, scope: 'chat' })),
  ])('rejects virtual origins with a valid owner before asking canTalk: %j', origin => {
    const canTalk = vi.fn(() => true);
    expect(observeInteractionContext(request, { findActive: () => ({ ...session, ...origin }), canTalk }).status).toBe(409);
    expect(canTalk).not.toHaveBeenCalled();
  });
  it.each(['chat', 'thread'])('preserves ordinary group %s queries', scope => {
    expect(observeInteractionContext(request, { findActive: () => ({ ...session, scope }), canTalk: () => true }).status).toBe(200);
  });
  it('does not let a snapshot grant future access', () => {
    let allowed = true; const deps = { findActive: () => session, canTalk: () => allowed };
    expect(observeInteractionContext(request, deps).body.context).toMatchObject({ canTalk: true });
    allowed = false;
    expect(observeInteractionContext(request, deps).body.context).toMatchObject({ canTalk: false });
  });
  it('requires host authority before lookup or access checks', () => {
    const findActive = vi.fn(); const canTalk = vi.fn();
    expect(observeInteractionContext({ ...request, trustedHost: false }, { findActive, canTalk }).status).toBe(403);
    expect(findActive).not.toHaveBeenCalled(); expect(canTalk).not.toHaveBeenCalled();
  });
  it.each([undefined, { ...session, status: 'closed' }, { ...session, larkAppId: 'other' }, { ...session, sessionId: 'other' }])('rejects missing, closed or misrouted sessions', value => {
    expect(observeInteractionContext(request, { findActive: () => value, canTalk: () => true }).status).toBe(404);
  });
  it.each([{ ...session, ownerOpenId: '' }, { ...session, scope: undefined }, { ...session, rootMessageId: '' },
    { ...session, vcMeetingReceiver: {} }, { ...session, chatType: 'unknown' }])('does not invent missing origins', value => {
    expect(observeInteractionContext(request, { findActive: () => value, canTalk: () => true }).status).toBe(409);
  });
  it.each(['owner', 'on_other', ''])('rejects non-open-id actors', actorOpenId => {
    const findActive = vi.fn();
    expect(observeInteractionContext({ ...request, body: { ...request.body, actorOpenId } }, { findActive, canTalk: () => true }).status).toBe(400);
    expect(findActive).not.toHaveBeenCalled();
  });
  it('defaults to the authoritative owner only when no actor was supplied', () => {
    const talk = vi.fn(() => true);
    const result = observeInteractionContext({ ...request, body: { larkAppId: 'app1' } }, { findActive: () => session, canTalk: talk });
    expect(result.body.context).toMatchObject({ actorOpenId: 'ou_owner' });
    expect(talk).toHaveBeenCalledWith('app1', 'oc_chat', 'ou_owner', 'group');
  });
  it('keeps chat scope root null and uses its p2p policy', () => {
    const talk = vi.fn(() => false);
    const result = observeInteractionContext(request, { findActive: () => ({ ...session, scope: 'chat', chatType: 'p2p' }), canTalk: talk });
    expect(result.body.context).toMatchObject({ rootMessageId: null, canTalk: false });
    expect(talk).toHaveBeenCalledWith('app1', 'oc_chat', 'ou_owner', 'p2p');
  });
  it('requires explicit CLI identities and encodes paths', () => {
    const cmd = parseInteractionContextCommand(['--bot', 'app1', '--session', 'a/b', '--actor', 'ou_owner']);
    expect(cmd.path).toBe('/api/sessions/a%2Fb/interaction-context');
    expect(JSON.parse(cmd.init.body)).toEqual({ larkAppId: 'app1', actorOpenId: 'ou_owner' });
    for (const args of [[], ['--bot', 'app1'], ['--bot', 'app1', '--bot', 'app2'], ['--bot', '--session']]) expect(() => parseInteractionContextCommand(args)).toThrow();
  });
});

it('requires an explicit native-authorized actor for an ownerless group without assigning ownership', () => {
  const group = { ...session, scope: 'chat', rootMessageId: '', ownerOpenId: undefined };
  let allowed = true;
  const canTalk = vi.fn(() => allowed);
  const deps = { findActive: () => group, canTalk };
  expect(observeInteractionContext({ ...request, body: { larkAppId: 'app1' } }, deps).status).toBe(409);
  expect(canTalk).not.toHaveBeenCalled();
  expect(observeInteractionContext(request, deps).body.context).toMatchObject({
    ownerOpenId: null, actorOpenId: 'ou_owner', rootMessageId: null, canTalk: true,
  });
  expect(canTalk).toHaveBeenCalledWith('app1', 'oc_chat', 'ou_owner', 'group');
  expect(group.ownerOpenId).toBeUndefined();
  allowed = false;
  expect(observeInteractionContext(request, deps).body.context).toMatchObject({ canTalk: false });
  expect(observeInteractionContext(request, { ...deps, findActive: () => ({ ...group, chatType: 'p2p' }) }).status).toBe(409);
});


it('uses only configured real group scopes without inventing a Worker owner', () => {
 const group=configuredGroupContext('app1','chat:oc_configured',id=>id==='oc_configured');
 expect(group).toMatchObject({chatId:'oc_configured',scope:'chat',ownerOpenId:'',active:true});
 expect(configuredGroupContext('app1','chat:oc_other',()=>false)).toBeUndefined();
 expect(configuredGroupContext('app1','chat:http_virtual',()=>true)).toBeUndefined();
 expect(configuredGroupContext('app1','om_topic',()=>true)).toBeUndefined();
 const query={trustedHost:true,daemonAppId:'app1',sessionId:'chat:oc_configured',body:{larkAppId:'app1',actorOpenId:'ou_member'}};
 expect(observeInteractionContext(query,{findActive:()=>group,canTalk:()=>true}).body.context).toMatchObject({ownerOpenId:null,actorOpenId:'ou_member',canTalk:true});
 expect(observeInteractionContext(query,{findActive:()=>group,canTalk:()=>false}).body.context).toMatchObject({canTalk:false});
});


describe('optional source principal bound to native origin', () => {
  it.each(['p2p', 'group'])('uses the %s policy without any destination membership lookup', async chatType => {
    const current={...session,chatType,scope:'chat'};
    const resolveUnionId=vi.fn(async ()=>'on_owner'),canTalk=vi.fn(()=>true);
    const result=await observeInteractionContextWithPrincipal({...request,body:{...request.body,resolvePrincipal:true}},
      {findActive:()=>current,canTalk,resolveUnionId});
    expect(result.status).toBe(200);
    expect(result.body.context).toMatchObject({actorPrincipal:{kind:'union',unionId:'on_owner'}});
    expect(resolveUnionId).toHaveBeenCalledExactlyOnceWith('ou_owner');
    expect(canTalk).toHaveBeenCalledWith('app1','oc_chat','ou_owner',chatType);
  });
  it('leaves ordinary context reads independent of contact lookup',async()=>{
    const resolveUnionId=vi.fn(async()=>{throw Error('offline');});
    expect((await observeInteractionContextWithPrincipal(request,{findActive:()=>session,canTalk:()=>true,resolveUnionId})).status).toBe(200);
    expect(resolveUnionId).not.toHaveBeenCalled();
  });
  it('never looks up a principal when host or talk permission is denied',async()=>{
    const resolveUnionId=vi.fn(async()=>'on_owner');
    for(const trustedHost of [true,false])await observeInteractionContextWithPrincipal({...request,trustedHost,body:{...request.body,resolvePrincipal:true}},
      {findActive:()=>session,canTalk:()=>false,resolveUnionId});
    expect(resolveUnionId).not.toHaveBeenCalled();
  });
  it('keeps an unresolved principal App-local',async()=>{
    const result=await observeInteractionContextWithPrincipal({...request,body:{...request.body,resolvePrincipal:true}},
      {findActive:()=>session,canTalk:()=>true,resolveUnionId:async()=>null});
    expect(result.body.context).toMatchObject({actorPrincipal:{kind:'app_open',larkAppId:'app1',openId:'ou_owner'}});
  });
  it.each(['permission','session'])('rejects %s changes while contact identity is being read',async change=>{
    let active:InteractionSession|undefined={...session},allowed=true;
    const result=await observeInteractionContextWithPrincipal({...request,body:{...request.body,resolvePrincipal:true}},
      {findActive:()=>active,canTalk:()=>allowed,resolveUnionId:async()=>{if(change==='session')active=undefined;else allowed=false;return 'on_owner';}});
    expect(result).toEqual({status:409,body:{ok:false,error:'interaction_context_changed'}});
  });
  it('resolves an explicit actor in an ownerless group without assigning ownership',async()=>{
    const group={...session,scope:'chat',ownerOpenId:undefined};
    const result=await observeInteractionContextWithPrincipal({...request,body:{...request.body,resolvePrincipal:true}},
      {findActive:()=>group,canTalk:()=>true,resolveUnionId:async()=>'on_owner'});
    expect(result.body.context).toMatchObject({ownerOpenId:null,actorOpenId:'ou_owner',actorPrincipal:{kind:'union',unionId:'on_owner'}});
    expect(group.ownerOpenId).toBeUndefined();
  });
  it('parses the optional flag and rejects duplicates',()=>{
    const parsed=parseInteractionContextCommand(['--principal','--bot','app1','--session','s1','--actor','ou_owner']);
    expect(JSON.parse(parsed.init.body)).toEqual({larkAppId:'app1',actorOpenId:'ou_owner',resolvePrincipal:true});
    expect(()=>parseInteractionContextCommand(['--principal','--principal','--bot','app1','--session','s1'])).toThrow();
  });
});
