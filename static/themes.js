/* A palette is a complete design system, independent of the OS light/dark setting. */
(() => {
  const palettes=Object.freeze({harbor:'港灣 · 墨綠與暖霧',terracotta:'陶土 · 棕銅與亞麻',slate:'暮山 · 岩灰與鳶尾'});
  const normalize=value=>Object.hasOwn(palettes,value)?value:value==='dark'?'slate':'harbor';
  const apply=value=>{
    const name=normalize(value);document.documentElement.dataset.palette=name;
    document.documentElement.removeAttribute('data-theme');
    try{localStorage.setItem('dc.palette',name);}catch{}
    window.dispatchEvent(new CustomEvent('palettechange',{detail:name}));return name;
  };
  window.DashcamThemes=Object.freeze({palettes,normalize,apply});
  let saved='harbor';try{saved=localStorage.getItem('dc.palette')||localStorage.getItem('dc.theme')||saved;}catch{}
  apply(saved);
})();
