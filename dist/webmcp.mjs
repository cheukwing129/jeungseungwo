/** Experimental adapter. The app calls this only when its source feature flag is enabled. */
export function registerGameTools(context,{getState,menuOpen,advance,choose,maximumOptions,listen}) {
  if(!context?.registerTool)return;
  const lifecycle=new AbortController();
  const object=input=>input && typeof input==='object' && !Array.isArray(input);
  const noInput=input=>{
    if(!object(input) || Object.keys(input).length)throw new Error('不需要輸入參數。');
  };
  const tools=[
    {
      name:'read_game_state',title:'讀取目前劇情',
      description:'Read the visible dialogue, current chapter and choices without changing the game.',
      annotations:{readOnlyHint:true,untrustedContentHint:false},
      inputSchema:{type:'object',properties:{},additionalProperties:false},
      execute(input){noInput(input);return getState();},
    },
    {
      name:'advance_game_dialogue',title:'繼續劇情',
      description:'Finish the current text animation or advance using the Continue action.',
      annotations:{readOnlyHint:false,untrustedContentHint:false},
      inputSchema:{type:'object',properties:{},additionalProperties:false},
      execute(input) {
        noInput(input);const state=getState();
        if(!state.started || state.current?.kind!=='text' || menuOpen())throw new Error('目前不能繼續對話。');
        advance();return {current:getState().current};
      },
    },
    {
      name:'choose_story_option',title:'選擇劇情選項',
      description:'Choose one of the currently visible numbered story options.',
      annotations:{readOnlyHint:false,untrustedContentHint:false},
      inputSchema:{type:'object',properties:{option:{type:'integer',minimum:1,maximum:maximumOptions}},
        required:['option'],additionalProperties:false},
      execute(input) {
        const state=getState();
        if(!object(input) || Object.keys(input).some(key=>key!=='option') || !Number.isInteger(input.option) ||
          !state.started || state.current?.kind!=='choice' || !state.current.choices[input.option-1] || menuOpen()) {
          throw new Error('請提供目前選項的編號。');
        }
        choose(input.option-1);return {current:getState().current};
      },
    },
  ];
  for(const tool of tools) {
    try {Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}
  }
  listen('pagehide',()=>lifecycle.abort(),{once:true});
}
