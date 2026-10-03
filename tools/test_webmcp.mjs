import assert from 'node:assert/strict';
import {registerGameTools} from '../dist/webmcp.mjs';
import {WEBMCP_ENABLED} from '../dist/config.mjs';

assert.equal(WEBMCP_ENABLED,false);
const registered=new Map();let closed=false, selected=null, advanced=0, hide;
let state={started:true,chapter:'測試章節',current:{kind:'text',text:'對白'}};
registerGameTools({registerTool(tool,options){registered.set(tool.name,{tool,options});}}, {
  getState:()=>state,menuOpen:()=>closed,advance:()=>advanced++,choose:index=>selected=index,
  maximumOptions:4,listen:(name,callback)=>{assert.equal(name,'pagehide');hide=callback;},
});
const read=registered.get('read_game_state').tool, next=registered.get('advance_game_dialogue').tool,
  choose=registered.get('choose_story_option').tool;
assert.equal(registered.size,3);assert.equal(read.execute({}),state);
for(const input of [null,[],{},'bad',{extra:true}]) {
  if(input && !Array.isArray(input) && typeof input==='object' && !Object.keys(input).length)continue;
  assert.throws(()=>read.execute(input));
}
next.execute({});assert.equal(advanced,1);closed=true;assert.throws(()=>next.execute({}));closed=false;
state={...state,current:{kind:'choice',choices:[{text:'甲'},{text:'乙'},{text:'丙'},{text:'丁'}]}};
assert.throws(()=>next.execute({}));assert.equal(choose.inputSchema.properties.option.maximum,4);
choose.execute({option:4});assert.equal(selected,3);
for(const input of [{option:0},{option:5},{option:'1'},{option:1,extra:true},null,[]])assert.throws(()=>choose.execute(input));
closed=true;assert.throws(()=>choose.execute({option:1}));closed=false;
state.started=false;assert.throws(()=>choose.execute({option:1}));
hide();for(const {options} of registered.values())assert.equal(options.signal.aborted,true);
registerGameTools(null,{});registerGameTools({registerTool(){throw new Error('unsupported');}}, {
  getState:()=>state,menuOpen:()=>closed,advance(){},choose(){},maximumOptions:4,listen(){},
});
console.log(JSON.stringify({defaultFlag:'off',experimentalAdapterValidation:'passed',dynamicChoiceLimit:'passed',
  closedMenuAndTitleGuard:'passed',pagehideAbort:'passed',unsupportedApi:'handled'},null,2));
