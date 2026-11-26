const byId = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];

const examples = {
  daily: {
    label: '日常叠穿',
    image: 'assets/looks.png',
    description: '正面站姿，灰绿衬衫敞开，露出浅内搭和深灰裤腰。',
    title: '配色容易借鉴，层次看习惯',
    basis: '浅内搭和深裤之间的分界让宽松叠穿也显得利落。',
    impact: '站定让裤腿更平整，走动时裤脚可能在鞋面堆褶。',
    appeal: '敞开的门襟露出一条浅色竖线，内搭和深色裤腰又形成横向分界，所以宽松的轮廓仍然分明。',
    camera: '照片里人物正面站定，裤线较直。浅深对比在日常仍能成立，裤脚的垂线可能随动作改变。单张图看不出镜头是否改变了人物比例。',
    proportion: '关键是裤腰与浅内搭下摆的相对位置。内搭盖过裤腰较多时，上下身的分界会下降。图中只能看到裤脚碰到鞋面。',
    styling: '短发停在翻领上方，让领口露得完整。长发垂在胸前可能挡住一部分门襟。视觉重点来自衣服的明暗，图中看不出特定妆容是必要的。',
    adapt: '有浅上衣和深裤，就可以借鉴上下身的颜色分界。有敞开穿的衬衫，还能保留图中外层的轮廓。',
    buyTitle: '优先考虑一件能敞开的衬衫',
    buyReason: '想要图中的叠穿感、又已有浅上衣和深裤时，这一件最能改变整体。挑门襟自然垂下、肩部活动有余量的款式。只喜欢浅深配色时，现有两件就够。',
    context: {
      work: '款式和配色偏低调，适合着装较灵活的通勤。若办公室要求正装，宽松衬衫和休闲叠穿会偏随意。',
      weekend: '宽松的衬衫加阔腿裤符合休闲场景。需要走很久时，裤脚是否压鞋比照片里的裤线更重要。',
      layered: '你喜欢叠穿，衬衫敞开能保留层次，也能看见内搭和裤腰的分界。',
      simple: '你偏爱轻便，整套会多一层。浅色上衣配深裤仍能保留最明显的对比。',
    },
    marks: [
      ['领口', '56%', '17%', '短发停在翻领上方，领口轮廓完整。'],
      ['腰线', '54%', '35%', '敞开的衬衫露出浅色内搭和深色裤腰的交界。'],
      ['裤脚', '52%', '88%', '裤脚靠在黑色鞋面上。站立时可见落点，走动效果未知。'],
    ],
  },
  street: {
    label: '长外套街拍',
    image: 'assets/inspiration-street.png',
    description: '低机位街拍，人物跨步，长外套向两侧摆开。',
    title: '配色能保留，动感难照搬',
    basis: '长外套被跨步带开，浅内搭和裤腰才露得这么多。自然站立时轮廓通常会收拢。',
    impact: '跨步、低机位与侧逆光放大了衣摆和纵向线条。日常最容易保留的是浅内搭与深外层的对比。',
    appeal: '深色外套的两片衣摆把浅色内搭围在中间。张开的下摆和跨步同向变化，让整套看起来更有动势。',
    camera: '跨步把衣摆带离身体，低机位也强化了由鞋到裤腰的纵向线条，侧光描出了外套边缘。正常视线下自然站立，衣摆更可能贴近腿部。单张图无法判断修图或量出比例变化。',
    proportion: '长外套自然垂下时，门襟是否还能露出浅内搭，比单看身高更能决定效果。长衣摆和宽裤同时占据较大面积，视觉重量更集中在下半身。',
    styling: '束发把脸周和领口留出来，唇色在深色外套旁形成一个小亮点。披发或淡唇会减弱脸周的利落感，但衣服仍可保持浅深对比。',
    adapt: '深色外套里加浅色上衣就能借鉴明暗。外套较短也能形成对比，少了长衣摆的动势。',
    buyTitle: '优先看自然垂下也有轮廓的外套',
    buyReason: '如果最喜欢的是长外套围出浅色内搭的效果，优先看门襟自然敞开、衣摆离地且迈步方便的款式。只喜欢配色时，已有深色外套即可借鉴。',
    context: {
      work: '浅深配色可用于通勤。若经常赶路或上下楼，长衣摆和宽裤组合的活动余量比照片里的气势更重要。',
      weekend: '适合想要长外套轮廓的周末出门。自然站定时，衣摆的展开幅度会比街拍小。',
      layered: '你喜欢叠穿，深外套与浅内搭的组合有吸引力。整套是否适合还取决于你对长衣摆的接受程度。',
      simple: '你偏爱轻便，长外套叠阔腿裤这套不太贴合日常习惯。保留浅上衣和深裤，就能留下配色上的亮点。',
    },
    marks: [
      ['领口', '54%', '17%', '束发露出领口。脸周的线条清楚，视觉注意力不会全落在大衣摆上。'],
      ['衣摆', '20%', '55%', '跨步把外套向两侧带开，让中间的浅内搭和裤腰露得更多。'],
      ['步幅', '48%', '86%', '前后脚距离大，鞋和裤脚更靠近镜头，照片中的纵向比例可能被强化。'],
    ],
  },
};

const preferenceTitles = {
  daily: { layered: '整套符合你的叠穿偏好', simple: '配色适合你，外层可省' },
  street: { layered: '叠穿合拍，街拍效果会减弱', simple: '整套偏重，配色可以借鉴' },
};
const detailFields = {
  'photo-impact': 'impact', appeal: 'appeal', camera: 'camera', proportion: 'proportion',
  styling: 'styling', adapt: 'adapt', 'buy-title': 'buyTitle', 'buy-reason': 'buyReason',
};

const picker = byId('picker');
const analysis = document.querySelector('.analysis');
const photo = byId('photo');
const marks = all('[data-mark]');
const contextButtons = all('[data-context]');
const context = { preference: 'unknown', occasion: 'unknown' };
let activeCase = 'daily';
let ownImageUrl;

function togglePanel(button, panel, open) {
  button.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
}

function selectMark(index) {
  marks.forEach((button, position) => {
    button.setAttribute('aria-pressed', String(index === position));
  });
  byId('evidence').textContent = examples[activeCase].marks[index][3];
}

function showMarks(open) {
  togglePanel(byId('show-marks'), byId('evidence'), open);
  byId('show-marks').textContent = open ? '收起图上细节' : '看图上细节';
  marks.forEach(button => { button.hidden = !open; });
  if (open) {
    selectMark(1);
    analysis.scrollTop = 0;
  }
}

function renderVerdict() {
  const example = examples[activeCase];
  const preferenceReason = example.context[context.preference];
  const occasionReason = example.context[context.occasion];
  const personal = [preferenceReason, occasionReason].filter(Boolean).join('');
  byId('verdict-title').textContent = preferenceTitles[activeCase][context.preference] || example.title;
  byId('fit-basis').textContent = preferenceReason || occasionReason || example.basis;
  byId('personal-note').textContent = personal || '当前判断基于参考图。选一项就能看到它如何影响结论。';
  contextButtons.forEach(button => {
    const selected = context[button.dataset.context] === button.dataset.value;
    button.setAttribute('aria-pressed', String(selected));
  });
}

function showExample(key) {
  activeCase = key;
  const example = examples[key];
  byId('source-label').textContent = '示例图 · ' + example.label;
  byId('result').hidden = false;
  byId('own-result').hidden = true;
  byId('show-marks').hidden = false;
  photo.setAttribute('aria-label', example.description);
  photo.style.backgroundImage = 'url("' + example.image + '")';
  photo.style.backgroundSize = key === 'daily' ? '200% 100%' : 'contain';
  photo.style.backgroundPosition = key === 'daily' ? 'right' : 'center';
  example.marks.forEach(([label, x, y], index) => {
    marks[index].textContent = label;
    marks[index].style.setProperty('--x', x);
    marks[index].style.setProperty('--y', y);
  });
  Object.entries(detailFields).forEach(([id, field]) => { byId(id).textContent = example[field]; });
  showMarks(false);
  byId('garment-result').hidden = true;
  renderVerdict();
  analysis.scrollTop = 0;
}

function garmentAdvice(description) {
  const hasOuter = /衬衫|外套|风衣|大衣|夹克/.test(description);
  const hasTop = /内搭|打底|上衣|针织|毛衣|T恤/i.test(description);
  const hasPants = /裤/.test(description);
  if (hasOuter) {
    return activeCase === 'daily'
      ? '已有外层可以先用上。浅内搭配深裤时，敞开的门襟能保留图里的层次和颜色分界。'
      : '已有外套能借鉴深外层与浅内搭的对比。较短的外套会少一些衣摆动感，配色仍然成立。';
  }
  if (hasTop && hasPants) return '已经有上衣和裤子，可以先考虑两件的明暗是否拉得开。上浅下深就能留下最明显的配色特点。';
  if (hasTop) return '这件上衣可以作内搭。如果它是浅色，深裤或深外套更容易形成图里的对比。';
  if (hasPants) return '如果这条裤子颜色较深，可以用浅色上衣保留上下身分界。裤脚是否搭鞋，要结合具体裤长和鞋型判断。';
  return '示例能识别上衣、裤子和外套这几类描述。可写「黑色阔腿裤」或「米白打底」查看对应建议。';
}

marks.forEach((button, index) => { button.onclick = () => selectMark(index); });
byId('show-marks').onclick = () => showMarks(byId('evidence').hidden);
for (const [buttonId, panelId] of [['edit-context', 'context'], ['read-analysis', 'factors']]) {
  const button = byId(buttonId);
  const panel = byId(panelId);
  button.onclick = () => {
    togglePanel(button, panel, panel.hidden);
    if (!panel.hidden) panel.scrollIntoView({ block: 'nearest' });
  };
}
contextButtons.forEach(button => {
  button.onclick = () => {
    context[button.dataset.context] = button.dataset.value;
    renderVerdict();
  };
});
byId('apply-garment').onclick = () => {
  const value = byId('garment').value.trim();
  byId('garment-result').textContent = value ? garmentAdvice(value) : '可以写一件已有的上衣、裤子或外套。';
  byId('garment-result').hidden = false;
};
byId('change').onclick = byId('pick-example').onclick = () => picker.showModal();
byId('close').onclick = () => picker.close();
all('[data-case]').forEach(button => {
  button.onclick = () => {
    picker.close();
    showExample(button.dataset.case);
    if (ownImageUrl) URL.revokeObjectURL(ownImageUrl);
    ownImageUrl = undefined;
  };
});
byId('file').onchange = event => {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    if (ownImageUrl) URL.revokeObjectURL(ownImageUrl);
    ownImageUrl = url;
    picker.close();
    showMarks(false);
    photo.style.backgroundImage = 'url("' + url + '")';
    photo.style.backgroundPosition = 'center';
    photo.style.backgroundSize = 'contain';
    photo.setAttribute('aria-label', '你的穿搭参考图');
    byId('source-label').textContent = '你的参考图';
    byId('show-marks').hidden = true;
    byId('result').hidden = true;
    byId('own-result').hidden = false;
    byId('file-error').textContent = '';
    analysis.scrollTop = 0;
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    byId('file-error').textContent = '这张图无法预览，可另选 JPG 或 PNG。';
  };
  image.src = url;
};

showExample('daily');
