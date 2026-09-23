kodReady.push(function(){
	var APP_ID   = '{{package.id}}';
	var API      = '{{pluginApi}}';
	// 带版本号的图标 URL：换图后不必等浏览器缓存过期（发版时记得升 package.json 的 version）
	var ICON     = '{{pluginHost}}static/images/icon.svg?v={{package.version}}';
	var OPEN_WITH= '{{config.openWith}}';
	var CLAIM_IMG= '{{config.claimImage}}' == '1';
	var EXT_WAVE = '{{config.fileExt}}';
	var SORT     = parseInt('{{config.fileSort}}') || 120;
	var L        = function(key, fallback){ return LNG['wavedrom.' + key] || fallback || key; };

	// foo.wave / foo.wave.svg / foo.wave.png；kodbox 的 ext 只取最后一个点，故按整个名字判断
	var endsWith = function(name, suffix){ return name.slice(-suffix.length) === suffix; };
	var waveKind = function(name){
		name = (name || '').toLowerCase();
		if (endsWith(name, '.wave.png')) return 'png';
		if (endsWith(name, '.wave.svg')) return 'svg';
		if (endsWith(name, '.wave'))     return 'json';
		return '';
	};
	var openArgs = function(path, ext, name, args){
		core.openFile(API, OPEN_WITH, [path, ext, name, args]);
	};

	Events.bind('explorer.kodApp.before', function(appList){
		appList.push({
			name: APP_ID,
			title: L('app.title', 'WaveDrom'),
			ext: EXT_WAVE,
			sort: SORT,
			icon: 'x-item-icon x-wavedrom',
			appFileEdit: true, appFileView: true,
			callback: function(path, ext, name, args){ openArgs(path, ext, name, args); }
		});

		// .wave.png / .wave.svg 的真实 ext 是 png / svg，走不到上面的关联；
		// kodApp.open 是所有打开动作的唯一入口(双击、打开方式、程序调用都经过它)，
		// 在这里按整个文件名改派，普通图片不受影响。
		if (!CLAIM_IMG || !window.kodApp || kodApp.__wavedromPatched) return;
		kodApp.__wavedromPatched = true;
		var origin = kodApp.open;
		kodApp.open = function(path, ext, name, app, args){
			if (!app && waveKind(name)) { app = APP_ID; }
			return origin.call(kodApp, path, ext, name, app, args);
		};
	});

	Events.bind('explorer.lightApp.load', function(listData){
		listData[APP_ID] = {
			name: L('app.title', 'WaveDrom'),
			desc: L('meta.desc', '波形图编辑器'),
			category: '{{package.category}}',
			appUrl: API,
			openWith: OPEN_WITH,
			icon: ICON
		};
	});

	// 左侧菜单入口(不带文件)：打开的是一个空白图表，改完用顶栏「导出」下载，或从文件列表建文件再编辑
	Router.mapIframe({ page: APP_ID, title: '{{package.name}}', url: API, ignoreLogin: 1 });
	Events.bind('main.menu.loadBefore', function(listData){
		listData[APP_ID] = {
			name: '{{package.menu}}',
			url: API,
			target: OPEN_WITH,
			subMenu: '{{config.menuSubMenu}}',
			menuAdd: '{{config.menuAdd}}',
			icon: ICON
		};
	});

	// 新建：.wave 走核心默认流程(建完自动打开)；两种图片要自己建文件再补渲染
	Events.bind('rightMenu.newFileAdd', function(menuList){
		menuList.push({ type:'wave', name:L('new.wave', '时序图(源文件)'), createOpen:1, appName:APP_ID });
		if (!CLAIM_IMG) return;
		menuList.push({ type:'wavesvg', name:L('new.wavesvg', '时序图(SVG)'),
			callback: function(){ createFile('svg'); } });
		menuList.push({ type:'wavepng', name:L('new.wavepng', '时序图(PNG)'),
			callback: function(){ createFile('png'); } });
	});

	// 图片类占位文件先建成空的：编辑器打开后发现是空文件，会按起始图表渲染一次再落盘，
	// 元数据由编辑器自己写(和手动「导出」同一条路)，插件里不必重造一份 PNG/SVG 编码器。
	var createFile = function(kind){
		var root = kodApp.rootExplorer && kodApp.rootExplorer();
		var pa = root && root.pathAction;
		if (!pa || !pa.newFileContent) { return Tips.tips(L('new.needFolder'), 'warning'); }
		var father = (pa.currentPath() || '').replace(/\/+$/, '');
		var name = (LNG['explorer.newFile'] || '新建文件') + '.wave.' + kind;
		pa.newFileContent(name, '', null, function(info){
			var thePath = (info && info.path) || (father + '/' + name);
			kodApp.open(thePath, kind, (info && info.name) || name, APP_ID, { fresh: 1 });
		});
	};

	// 只有 .wave 源码文件换波形图标；.wave.png / .wave.svg 交给核心的封面缩略图
	// （fileIconMake 一返回 icon 就会顶掉 path-ico-image 分支，图片文件将只剩图标没有预览）。
	// 必须套 path-ico 外壳——图标尺寸来自核心的 `.file > .path-ico .x-item-icon`，
	// 直接给一个裸 <i> 会因为没有尺寸而什么都画不出来。
	Events.bind('path.list.fileIconMake', function(item, view, out){
		if (!item || waveKind(item.name) !== 'json') return;
		out.icon = '<i class="path-ico name-wave"><i class="x-item-icon x-wave"></i></i>';
	});

	$.addStyle('.x-item-icon.x-wavedrom,.x-item-icon.x-wave,'
		+ '.x-item-icon.x-wavesvg,.x-item-icon.x-wavepng{'
		+ 'background-image:url(' + ICON + ');background-size:80%;}'
		+ '.x-item-icon.x-wavedrom:not(.custom-bg){background-color:transparent!important;}');
});
