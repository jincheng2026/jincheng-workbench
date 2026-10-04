/* 测试用的最小界面：把每个可改格子画成 textarea，交给 kit 保存。
   这里故意写上 {{DOC}} 和 </script> 字样，测生成脚本只替换一次、并把 </script 转义。 */
(function () {
  var doc = JSON.parse(document.getElementById('jc-doc').textContent);
  var box = document.getElementById('app');
  box.textContent = '';
  doc.items.forEach(function (it) {
    Object.keys(it.fields || {}).forEach(function (k) {
      var t = document.createElement('textarea');
      t.setAttribute('data-item', it.id); t.setAttribute('data-field', k); t.value = it.fields[k];
      box.appendChild(t);
    });
  });
  window.__fixtureApp = '</script>';
})();
/* jc-app:eof */
