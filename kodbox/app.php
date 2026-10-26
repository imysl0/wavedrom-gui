<?php
/**
 * wavedrom-gui 波形图编辑器（WaveDrom / WaveJSON）
 *
 * 关联文件：
 *   xxx.wave        WaveJSON 源码（JSON 文本）
 *   xxx.wave.svg    导出的 SVG，<metadata> 内嵌 WaveJSON
 *   xxx.wave.png    导出的 PNG，iTXt 块内嵌 WaveJSON
 * 三种都能直接编辑并写回原文件；图片按导出时的风格重绘，不做有损转换。
 */
class wavedromPlugin extends PluginBase{
	function __construct(){
		parent::__construct();
	}

	public function regist(){
		$this->hookRegist(array(
			'user.commonJs.insert' => 'wavedromPlugin.echoJs',
		));
	}

	public function echoJs(){
		$this->echoFile('static/main.js');
	}

	private function endsWith($haystack, $needle){
		return substr($haystack, -strlen($needle)) === $needle;
	}

	/* 文件名 → 编辑目标类型。kodbox 的 ext 只取最后一个点（foo.wave.png 恒为 png）,
	   所以必须按整个文件名的后缀判断,不能依赖 ext。 */
	private function kindOf($name){
		$n = strtolower((string)$name);
		if ($this->endsWith($n, '.wave.png')) return 'png';
		if ($this->endsWith($n, '.wave.svg')) return 'svg';
		if ($this->endsWith($n, '.wave'))     return 'json';
		return '';
	}

	/**
	 * 编辑器页面：输出随包构建的 index.html,并注入
	 *   - 每文件独立的自动保存键（多标签页同开时不互相覆盖）
	 *   - WD_HOST 配置与 bridge.js（取文件 / 解码 / 写回）
	 * 注入脚本排在编辑器自身脚本之前,不改动编辑器任何逻辑。
	 *
	 * 只读文件在这儿会换成预览页：拿不到写权限时，编辑器那一整套外壳只是噪音。
	 */
	public function index(){
		$t = $this->target();
		if ($t['path'] !== '' && !$t['canWrite']) { return $this->previewPage($t); }
		$this->editorPage($t, false);
	}

	/** 「打开方式 → 波形预览」：只看图，可写与否都一样（可写的预览页有「编辑」按钮） */
	public function preview(){
		$this->previewPage($this->target());
	}

	/** 轮询端点：返回文件当前 mtime。只读元数据，供打开着的编辑器感知「文件已在别处被改」；
	    精确拦截由 save 的乐观锁负责，这里拿不到/漏报都无害 */
	public function mtime(){
		$path = $this->pathTrue($this->in['path']);
		if (!is_string($path) || $path === '') { show_json('path error', false); }
		$info = IO::info($path);
		if (!is_array($info) || $info['isFolder']) { show_json('path error', false); }
		show_json('ok', true, array('mtime' => (string)_get($info, 'modifyTime')));
	}

	/** 预览页给 .wave 源码出图用的渲染器：隐藏 iframe 装载编辑器，只出图、不落盘 */
	public function render(){
		$this->editorPage($this->target(), true);
	}

	/* 请求里的 path → 这次要打开的东西。名字与类型以盘上为准：新建走核心的行内改名，
	   插件回调只拿得到路径({source:N}/),绕一圈把用户输入的名字传回来反而多余,也防了
	   前端传错 name 把类型认歪。 */
	private function target(){
		$t = array('path'=>'', 'fileUrl'=>'', 'savePath'=>'', 'canWrite'=>false, 'name'=>'', 'kind'=>'', 'ver'=>'');
		$path = $this->pathTrue($this->in['path']);
		if (!is_string($path) || $path === '') return $t;
		if (substr($path, 0, 4) == 'http') { $t['fileUrl'] = $path; return $t; }

		$t['path']     = $path;
		$t['fileUrl']  = $this->filePathLink($path);
		$t['canWrite'] = (bool)ActionCall('explorer.auth.fileCanWrite', $path);
		if ($t['canWrite']) { $t['savePath'] = $path; }

		$name        = (string)$this->in['name'];
		$info        = IO::info($path);
		$modifyTime  = '';
		if (is_array($info) && !$info['isFolder']) {
			if ($info['name']) { $name = $info['name']; }
			$modifyTime = (string)_get($info, 'modifyTime');
		}
		$t['name'] = $name;
		// 预览页拿它给图片 URL 换串:nginx 对图片是 max-age=30d,文件改了要能看出来
		$t['ver'] = $modifyTime;

		$kind = $this->kindOf($name);
		if ($kind === '' && $this->in['ext'] === 'wave') { $kind = 'json'; }
		$t['kind'] = $kind;
		return $t;
	}

	/* $renderOnly：只把编辑器当渲染器用——bridge.js 看到它就不装保存按钮、不做脏
	   检测、也不写盘(见 static/app/bridge.js 的 renderMode)。 */
	private function editorPage($t, $renderOnly){
		$file = $this->pluginPath . 'static/app/editor.html';
		if (!is_file($file)) { return $this->echoMissing(); }

		// 渲染用的自动保存键与编辑器分开:预览页起的隐藏 iframe 不该顶掉同一个文件在
		// 别的标签页里的「有未保存改动」基线。
		$docKey = ($renderOnly ? 'wdgui-render-' : 'wdgui-doc-')
			. substr(md5($t['path'] . '|' . $t['name']), 0, 16);
		$html = file_get_contents($file);
		$html = str_replace("'wdgui-doc-v1'", "'" . $docKey . "'", $html);

		$boot = '<script>var WD_HOST=' . json_encode(array(
			'fileUrl'    => $t['fileUrl'],
			'savePath'   => $t['savePath'],
			'canWrite'   => $t['canWrite'],
			'kind'       => $t['kind'],
			'fileName'   => $t['name'],
			'docKey'     => $docKey,
			'renderOnly' => $renderOnly,
			'mtime'      => $t['ver'],        // 打开时的文件 mtime：写回乐观锁的初始基准
			'mtimeApi'   => $this->pluginApi . 'mtime',   // 外部修改感知的轮询端点
			'watchRemote'=> !$renderOnly && _get($this->getConfig(), 'watchRemote') != '0',
			'saveApi'    => $this->pluginApi . 'save',
			'fresh'      => !$renderOnly && (bool)_get($this->hostArgs(), 'fresh'),
			'autoSave'   => !$renderOnly && _get($this->getConfig(), 'autoSave') == '1',
			'csrfToken'  => $renderOnly ? '' : $this->csrfToken(),
			'lng'        => $this->hostLang(),
		), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP) . ';</script>' . "\n"
		/* 只按版本号刷缓存的话,不换 version 的更新会一直命中旧 bridge.js（编辑器本体是
		   服务端读出来的,不受影响）;带上文件 mtime。 */
		. '<script src="' . $this->pluginHost . 'static/app/bridge.js?v=' . $this->packageVersion()
		. '-' . filemtime($this->pluginPath . 'static/app/bridge.js') . '"></script>' . "\n";
		/* 不能用 preg_replace 的 '$1' 拼替换串：文件名含 $1 之类子串时会被 PCRE 当反向引用,
		   把页面 JSON 换成 <body> 标签,该文件的编辑页直接损坏 */
		echo preg_replace_callback('/<body[^>]*>/i', function ($m) use ($boot) { return $m[0] . $boot; }, $html, 1);
	}

	/* 预览页：图就是内容——.wave.png / .wave.svg 直接摆原文件,.wave 走 render 路由借
	   编辑器渲一张 SVG。配置以 JSON 放在 <script type="application/json"> 里,页面自身
	   不需要内联脚本(文件名可能带尖括号,所以编码时把标签字符转掉)。 */
	private function previewPage($t){
		$file = $this->pluginPath . 'static/app/preview.html';
		if (!is_file($file)) { return $this->echoMissing(); }
		$js = $this->pluginHost . 'static/app/preview.js?v=' . $this->packageVersion()
			. '-' . filemtime($this->pluginPath . 'static/app/preview.js');

		$editUrl = $renderUrl = '';
		if ($t['path'] !== '') {
			$editUrl   = $this->pluginApi . 'index&path=' . rawurlencode($t['path']) . '&name=' . rawurlencode($t['name']);
			$renderUrl = $this->pluginApi . 'render&path=' . rawurlencode($t['path']);
		}
		$cfg = json_encode(array(
			'fileName'  => $t['name'],
			'kind'      => $t['kind'],
			'fileUrl'   => $t['fileUrl'],
			'ver'       => $t['ver'],
			'canWrite'  => $t['canWrite'],
			'mtimeApi'  => $this->pluginApi . 'mtime',
			'path'      => $t['path'],
			'watchRemote'=> _get($this->getConfig(), 'watchRemote') != '0',
			'editUrl'   => $editUrl,
			'renderUrl' => $renderUrl,
			'lng'       => $this->previewLang(),
		), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP);

		echo str_replace(
			array('__WD_PREVIEW_CFG__', '__WD_PREVIEW_JS__'),
			array($cfg, $js),
			file_get_contents($file));
	}

	private function echoMissing(){
		header('Content-Type: text/html; charset=utf-8');
		echo '<meta charset="utf-8"><p style="font:14px/2 sans-serif;padding:24px">'
			. LNG('wavedrom.errNoBuild') . '</p>';
	}

	/* core.openFile 把第四个参数原样 jsonEncode 进 URL 的 args 字段（新建文件时用它
	   标记「这是刚建的空文件,打开后先按当前图表渲染一次落盘」） */
	private function hostArgs(){
		$raw = (string)$this->in['args'];
		if ($raw === '') return array();
		$args = json_decode(html_entity_decode($raw, ENT_QUOTES, 'UTF-8'), true);
		return is_array($args) ? $args : array();
	}

	/* bridge.js 里要显示的少量文案：编辑器自带 i18n 只管自己的界面,宿主提示走 kodbox 语言包 */
	private function hostLang(){
		$keys = array('loading', 'save', 'saved', 'saving', 'dirty', 'readonly',
			'noMeta', 'loadFail', 'saveFail', 'noFile', 'saveAs', 'newDefault', 'badName',
			'conflict', 'conflictAsk', 'remoteChanged', 'remoteChangedDirty', 'reloadNew');
		$out = array();
		foreach ($keys as $k) { $out[$k] = LNG('wavedrom.host.' . $k); }
		return $out;
	}

	/* 预览页的文案，同上走语言包（键名前缀 wavedrom.preview.） */
	private function previewLang(){
		$keys = array('edit', 'loading', 'readonly', 'noFile', 'fail', 'noMeta');
		$out = array();
		foreach ($keys as $k) { $out[$k] = LNG('wavedrom.preview.' . $k); }
		return $out;
	}

	/* 核心的 autoPathParse 只归一化 explorer 自己的路由,交给插件的 path 仍是
	   「父目录ID + 文件名」;而 IO 层要的是「文件自身ID」形式({source:17}/),
	   少这一步会把文件当目录解析。 */
	private function pathTrue($path){
		if (!is_string($path) || substr($path, 0, 8) != '{source:') return $path;
		$path = KodIO::clear($path);
		if (!preg_match('/^\{source:(\d+)\}\/([^\/]+?)\/?$/u', $path, $m)) return $path;
		$item = Model('Source')->field('sourceID')->where(array(
			'parentID' => $m[1], 'name' => $m[2], 'isDelete' => 0))->find();
		return ($item && $item['sourceID']) ? '{source:' . $item['sourceID'] . '}/' : $path;
	}

	/**
	 * 写回文件。content 为文本,或 base64=1 时的 base64 串（PNG 二进制）。
	 * 这是插件自己的写接口,权限和类型都得自己把住:只允许写本插件关联的三种后缀,
	 * 且内容形态要与后缀相符——否则等于给用户开一个「往任意路径写任意文件」的口子。
	 */
	public function save(){
		$path = $this->pathTrue($this->in['path']);
		if (!is_string($path) || $path === '') { show_json(LNG('common.pathNotExists'), false); }
		$this->checkCsrf();
		if (!ActionCall('explorer.auth.fileCanWrite', $path)) {
			show_json(LNG('explorer.noPermissionWriteFile'), false);
		}

		// 类型以服务端解析出的文件名为准,不信任前端传来的 name
		$info = IO::info($path);
		if (!is_array($info) || $info['isFolder']) { show_json(LNG('common.pathNotExists'), false); }
		$kind = $this->kindOf($info['name']);
		if ($kind === '') { show_json(LNG('wavedrom.errType'), false); }

		$content = $this->in['content'];
		if (!is_string($content) || $content === '') { show_json(LNG('wavedrom.errEmpty'), false); }
		if (strlen($content) > 32 * 1024 * 1024) { show_json(LNG('wavedrom.errTooLarge'), false); }
		if ($this->in['base64'] == '1') {
			$content = base64_decode($content, true);
			if ($content === false) { show_json(LNG('wavedrom.errDecode'), false); }
		}
		if (!$this->kindMatch($kind, $content)) { show_json(LNG('wavedrom.errType'), false); }

		/* 乐观锁：bridge 带上它打开/上次保存成功时看到的 mtime。对不上 = 文件已被别处
		   （另一标签页、另一端）改过——放行就成了「最后写入者赢」，A 的编辑会被 B 的
		   陈旧内存静默盖掉。冲突时把可识别的标记同时放进 info 与 data（show_json 两处
		   落点随核心版本有别，前端两头都读）；force=1 是用户在提示里确认覆盖后的重发。
		   mtime 拿不到（异常存储后端）就退回无条件写，与旧行为一致。 */
		$baseMtime = (string)_get($this->in, 'baseMtime');
		if ($baseMtime !== '' && _get($this->in, 'force') != '1') {
			$curMtime = (string)_get($info, 'modifyTime');
			if ($curMtime !== '' && $curMtime !== $baseMtime) {
				$conflict = array(
					'conflict' => true, 'mtime' => $curMtime,
					'message'  => LNG('wavedrom.errConflict'),
				);
				show_json($conflict, false, $conflict);
			}
		}

		if (IO::setContent($path, $content) === false) {
			show_json(IO::getLastError(LNG('explorer.saveError')), false);
		}
		Hook::trigger('explorer.fileSaveStart', $path);
		$after = IO::info($path);
		show_json(LNG('explorer.saveSuccess'), true, array(
			'size' => _get($after, 'size'), 'modifyTime' => _get($after, 'modifyTime'),
		));
	}

	/* 全局 csrf 过滤对 plugin 路由是直接放行的（filter/post.class.php「插件内部自行处理」）,
	   写接口自己补上,豁免规则与核心保持一致(客户端 UA / accessToken)。
	   cookie 里的 token 会被核心在别的接口校验失败时清掉(见 checkCsrfToken 里的 Cookie::remove),
	   这时不能当作「没有防护」直接放行,退一步做同源判断。 */
	private function checkCsrf(){
		if (Model('SystemOption')->get('csrfProtect') != '1') return;
		if (isset($_REQUEST['accessToken'])) return;
		$ua = strtolower((string)$_SERVER['HTTP_USER_AGENT']);
		if (strstr($ua, 'kodbox') || strstr($ua, 'okhttp') || strstr($ua, 'kodcloud')) return;

		$token = $this->csrfToken();
		if ($token === '') {
			if (!$this->sameOrigin()) { show_json('CSRF_TOKEN error!', false); }
			return;
		}
		if ((string)$this->in['CSRF_TOKEN'] !== $token) {
			show_json('CSRF_TOKEN error!', false);
		}
	}

	private function csrfToken(){
		if (!class_exists('Cookie')) return '';
		return (string)Cookie::get('CSRF_TOKEN');
	}

	/* 浏览器发跨站写请求一定带 Origin(退一步还有 Referer),对不上站点的就拒;
	   两个头都没有的老客户端按不放行处理——宁可拒绝也不能默认放行。 */
	private function sameOrigin(){
		$from = (string)$_SERVER['HTTP_ORIGIN'];
		if ($from === '') { $from = (string)$_SERVER['HTTP_REFERER']; }
		$peer = parse_url($from);
		$self = parse_url('http://' . (string)$_SERVER['HTTP_HOST']);
		if (!is_array($peer) || !isset($peer['host']) || !isset($self['host'])) return false;
		return strtolower($peer['host']) === strtolower($self['host'])
			&& _get($peer, 'port') == _get($self, 'port');
	}

	/* 内容与后缀是否相配：png 看签名并走完整 chunk 链（IEND 恰好收尾，堵「魔数后夹带任意
	   负载」）;svg 必须带本编辑器导出必写的 WaveJSON 元数据标记、且不得出现脚本元素——
	   .svg 会被浏览器当文档直接打开,校验太松等于开放「把任意 HTML 存成 svg」的跳板
	   （CSRF token 存在非 httpOnly cookie 里,真被写进去就不是小事）;json 拒绝标记与超大内容 */
	private function kindMatch($kind, $content){
		$head = ltrim($content);
		if ($kind === 'png')  return $this->pngLooksValid($content);
		if ($kind === 'svg')  return strncmp($head, '<', 1) === 0
			&& stripos($content, '<svg') !== false
			&& preg_match('/<metadata[^>]*data-wavedrom/i', $content) === 1
			&& !preg_match('/<script[\s\/>]/i', $content);
		if ($kind === 'json') return strncmp($head, '<', 1) !== 0 && strlen($content) <= 8 * 1024 * 1024;
		return false;
	}

	/* PNG 完整性：签名 + chunk 链无越界走到 IEND、且 IEND 后无尾随数据。长度字段按无符号
	   解析并检查前进量,畸形输入不会拖成死循环。编辑器写回的图必然以此收尾,手工截断的
	   坏图在这里就被拒。 */
	private function pngLooksValid($content){
		if (strncmp($content, "\x89PNG\r\n\x1a\n", 8) !== 0) return false;
		$n = strlen($content);
		$off = 8;
		while ($off + 8 <= $n) {
			$chunk = unpack('Nlen/a4type', substr($content, $off, 8));
			$off += 12 + $chunk['len'];
			if ($chunk['type'] === 'IEND') return $off === $n;
			if ($off > $n) return false;
		}
		return false;
	}
}
