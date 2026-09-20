// 瞬态浮层收拢：页面离开（或 Tab 页回到前台）时统一关掉带遮罩的长按工具栏 / 抽屉 / 菜单。
// 起因：这类浮层都带全屏遮罩，z-index 往往高于页面所有按钮（含底部胶囊导航）；
// 一旦跨页残留，就会变成「页面能滚、按钮点不动」的隐形拦截层。
function transientLayerPatch(data, keys) {
  const patch = {};
  (keys || []).forEach((key) => {
    if (data && data[key]) patch[key] = false;
  });
  return patch;
}

function closeTransientLayers(page, keys, extra) {
  if (!page || typeof page.setData !== "function") return {};
  const patch = { ...transientLayerPatch(page.data, keys), ...(extra || {}) };
  if (Object.keys(patch).length) page.setData(patch);
  return patch;
}

module.exports = { closeTransientLayers, transientLayerPatch };
