const { chromium } = require('playwright');
const fs = require('fs');
const OUT = __dirname;  // スクリーンショットとデータの出力先
const path = require('path');
const TODAY = '2026-08-05';

// ---- テストデータ定義（30件） ----
const MODELS = {
  'キトー': ['CB形', 'M3形', 'CX形'],
  '象印': ['C21形', 'α形'],
  '大洋製器': ['TCB-1'],
};
const CAPS = ['0.5', '1', '1.5', '2', '3'];
const LOCS = ['資材倉庫A', '資材倉庫B', '第二倉庫'];

// 点検状況の内訳: 有効20 / 期限間近4 / 期限切れ3 / 未点検3
const INSPECTION_PLAN = [
  ...Array.from({ length: 20 }, (_, i) => ({ date: `2026-0${(i % 7) + 1}-1${i % 10}`.replace(/-0(\d\d)-/, '-$1-'), kind: 'valid' })),
  { date: '2025-08-10', kind: 'expiring' }, { date: '2025-08-20', kind: 'expiring' },
  { date: '2025-08-28', kind: 'expiring' }, { date: '2025-09-01', kind: 'expiring' },
  { date: '2024-05-10', kind: 'expired' }, { date: '2025-01-20', kind: 'expired' },
  { date: '2025-06-30', kind: 'expired' },
  null, null, null, // 未点検
];

const ITEMS = Array.from({ length: 30 }, (_, i) => {
  const maker = i < 18 ? 'キトー' : i < 28 ? '象印' : '大洋製器';
  const models = MODELS[maker];
  return {
    assetNo: '八' + String(100001 + i),
    maker,
    model: models[i % models.length],
    capacity: CAPS[i % CAPS.length],
    location: LOCS[i % LOCS.length],
    inspection: INSPECTION_PLAN[i],
  };
});

const BORROWERS = ['〇〇建設 A現場', '△△工業 B現場', '□□組 C現場', '〇〇建設 D現場', '××重機 E現場'];
const STAFF = ['佐藤', '鈴木', '高橋', '田中'];

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '  OK  ' : '  NG  '} ${label} => ${JSON.stringify(actual)}${ok ? '' : ' (期待: ' + JSON.stringify(expected) + ')'}`);
  ok ? pass++ : fail++;
}

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
  const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
  const errors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

  await page.goto('file://' + path.join(__dirname, 'index.html'));
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const row = no => page.locator('#invBody tr').filter({ has: page.locator(`td.assetno:text-is("${no}")`) });
  const cell = async (no, idx) => (await row(no).locator('td').nth(idx).textContent()).trim();
  const COL = { maker: 1, model: 2, cap: 3, loc: 4, status: 5, lastIns: 6, expiry: 7, sticker: 8 };

  // ===== 1. 在庫登録 30件 =====
  console.log('\n===== 1. 在庫登録（30件） =====');
  for (const it of ITEMS) {
    await page.click('#btnNew');
    await page.fill('#fAssetNo', it.assetNo);
    await page.selectOption('#fMaker', MODELS[it.maker] && ['キトー', '象印'].includes(it.maker) ? it.maker : '__other__');
    if (!['キトー', '象印'].includes(it.maker)) await page.fill('#fMakerOther', it.maker);
    await page.fill('#fModel', it.model);
    await page.selectOption('#fCapacity', it.capacity);
    await page.fill('#fLocation', it.location);
    await page.click('#btnSaveItem');
    await page.waitForTimeout(40);
  }
  check('登録件数', (await page.$$('#invBody tr')).length, 30);
  check('未処理ダイアログなし', dialogs, []);
  check('八100001 の内容', [await cell('八100001', COL.maker), await cell('八100001', COL.model),
                            await cell('八100001', COL.cap), await cell('八100001', COL.loc)],
        ['キトー', 'CB形', '0.5t', '資材倉庫A']);
  check('八100030 の内容（その他メーカー）', [await cell('八100030', COL.maker), await cell('八100030', COL.model)],
        ['大洋製器', 'TCB-1']);
  check('登録直後は全件が未点検（貸出可能0）',
        await page.$$eval('#capBody tr', rs => rs.reduce((n, r) => n + Number(r.children[2].textContent), 0)), 0);

  // ===== 2. 初回点検 =====
  console.log('\n===== 2. 初回点検（27件を合格登録／3件は未点検のまま） =====');
  let stickerSeq = 0;
  for (const it of ITEMS) {
    if (!it.inspection) continue;
    await row(it.assetNo).locator('button[data-act="inspect"]').click();
    await page.fill('#fInsDate', it.inspection.date);
    await page.fill('#fInspector', STAFF[stickerSeq % STAFF.length]);
    await page.fill('#fStickerNo', 'STK-' + it.inspection.date.slice(0, 4) + '-' + String(++stickerSeq).padStart(3, '0'));
    await page.click('#btnConfirmInspect');
    await page.waitForTimeout(40);
  }

  const inspCounts = await page.$$eval('#invBody tr', rs => {
    const c = { 有効: 0, 期限間近: 0, 期限切れ: 0, 未点検: 0 };
    rs.forEach(r => {
      const t = r.children[7].textContent;
      if (t.includes('期限間近')) c.期限間近++;
      else if (t.includes('期限切れ')) c.期限切れ++;
      else if (t.includes('未点検')) c.未点検++;
      else if (t.includes('有効')) c.有効++;
    });
    return c;
  });
  check('点検状態の内訳', inspCounts, { 有効: 20, 期限間近: 4, 期限切れ: 3, 未点検: 3 });
  check('サマリカード（点検期限間近/点検切れ・未点検）',
        await page.$$eval('#cards .card', cs => [cs[2].querySelector('.num').textContent, cs[3].querySelector('.num').textContent]),
        ['4', '6']);
  check('点検切れ・未点検の6台は貸出ボタンが無効',
        await page.$$eval('#invBody tr', rs => rs.filter(r => {
          const t = r.children[7].textContent;
          return t.includes('期限切れ') || t.includes('未点検');
        }).every(r => r.querySelector('button[data-act="lend"]').disabled)), true);
  check('有効・期限間近の24台は貸出ボタンが有効',
        await page.$$eval('#invBody tr', rs => rs.filter(r => {
          const t = r.children[7].textContent;
          return !t.includes('期限切れ') && !t.includes('未点検');
        }).every(r => !r.querySelector('button[data-act="lend"]').disabled)), true);

  // 貸出不可の機器で、モーダルの警告文と貸出ボタン無効を確認
  const expiredNo = ITEMS.find(i => i.inspection && i.inspection.kind === 'expired').assetNo;
  await row(expiredNo).locator('button[data-act="detail"]').click();
  await page.waitForTimeout(80);
  const expiredDetail = (await page.textContent('#detailBody')).replace(/\s+/g, ' ').trim();
  check('点検切れ機器の詳細に「期限切れ」表示', expiredDetail.includes('点検ステッカー: 期限切れ'), true);
  await page.click('#overlayDetail [data-close]');

  // ===== 3. 貸し出し =====
  console.log('\n===== 3. 貸し出し（12件） =====');
  const lendable = ITEMS.filter(i => i.inspection && i.inspection.kind !== 'expired').slice(0, 12);
  for (const [n, it] of lendable.entries()) {
    await row(it.assetNo).locator('button[data-act="lend"]').click();
    await page.waitForTimeout(60);
    if (n === 0) {
      check('貸出モーダルの対象表示', await page.inputValue('#lendItemLabel'),
            `${it.assetNo}（${it.maker} ${it.model} ${it.capacity}t）`);
      check('点検ステッカー有効の案内が出る', (await page.textContent('#lendNotice')).includes('点検ステッカー: 有効'), true);
    }
    await page.fill('#fLentDate', TODAY);
    await page.fill('#fDueDate', '2026-09-30');
    await page.fill('#fBorrower', BORROWERS[n % BORROWERS.length]);
    await page.fill('#fRequester', STAFF[n % STAFF.length]);
    await page.click('#btnConfirmLend');
    await page.waitForTimeout(50);
  }
  check('貸出中の件数', await page.$$eval('#invBody tr', rs => rs.filter(r => r.children[5].textContent.includes('貸出中')).length), 12);
  check('サマリカード「貸出中」', await page.$$eval('#cards .card', cs => cs[1].querySelector('.num').textContent), '12');
  check('貸出中の行に貸出先が表示される', (await cell(lendable[0].assetNo, COL.loc)).startsWith('貸出先:'), true);
  check('貸出中は貸出ボタンが消え返却ボタンになる',
        await row(lendable[0].assetNo).locator('button[data-act="return"]').count(), 1);

  // 期限間近の機器を貸し出す際に警告が出るか
  const expiringNo = ITEMS.find(i => i.inspection && i.inspection.kind === 'expiring').assetNo;
  const expiringStatus = await cell(expiringNo, COL.status);
  if (expiringStatus.includes('在庫中')) {
    await row(expiringNo).locator('button[data-act="lend"]').click();
    await page.waitForTimeout(80);
    check('期限間近の機器は警告つきで貸出可', (await page.textContent('#lendNotice')).includes('点検有効期限が近づいています'), true);
    check('  ─ 貸出ボタン自体は押せる', await page.locator('#btnConfirmLend').isDisabled(), false);
    await page.click('#overlayLend [data-close]');
  }

  // ===== 4. 返却 → 分解点検 =====
  console.log('\n===== 4. 返却と返却後点検（8件返却：7件合格／1件要修理） =====');
  const returning = lendable.slice(0, 8);
  for (const [n, it] of returning.entries()) {
    await row(it.assetNo).locator('button[data-act="return"]').click();
    await page.waitForTimeout(60);
    if (n === 0) check('返却モーダルの対象表示', (await page.inputValue('#retItemLabel')).startsWith(it.assetNo), true);
    await page.fill('#fReturnedDate', TODAY);
    await page.fill('#fReturnNotes', n === 7 ? 'ロードチェーンに変形あり' : '異常なし');
    await page.click('#btnConfirmReturn');
    await page.waitForTimeout(120);

    if (n === 0) {
      check('返却直後のステータス', await cell(it.assetNo, COL.status), '点検待ち/点検中');
      check('返却後に点検モーダルが自動で開く', await page.isVisible('#overlayInspect.open'), true);
      check('点検種別が「返却後点検」で開く', await page.inputValue('#fInsType'), 'post-return');
    }
    // 分解点検の記録（最後の1件のみ要修理）
    await page.fill('#fInsDate', TODAY);
    await page.fill('#fInspector', STAFF[n % STAFF.length]);
    if (n === 7) {
      await page.selectOption('#fInsResult', 'repair');
      await page.fill('#fInsNotes', 'ロードチェーン交換のため修理へ');
    } else {
      await page.fill('#fStickerNo', 'STK-2026-R' + String(n + 1).padStart(2, '0'));
    }
    await page.click('#btnConfirmInspect');
    await page.waitForTimeout(60);
  }

  const ok0 = returning[0].assetNo;
  check('返却後点検に合格 → 在庫中に戻る', await cell(ok0, COL.status), '在庫中');
  check('  ─ 点検日が返却日で更新', await cell(ok0, COL.lastIns), '2026/08/05');
  check('  ─ 有効期限が1年後に更新', (await cell(ok0, COL.expiry)).startsWith('2027/08/05'), true);
  check('  ─ 新しいステッカー番号が反映', await cell(ok0, COL.sticker), 'STK-2026-R01');
  check('  ─ 再び貸し出せる', await row(ok0).locator('button[data-act="lend"]').isDisabled(), false);

  const rep = returning[7].assetNo;
  check('要修理は点検待ち/点検中のまま', await cell(rep, COL.status), '点検待ち/点検中');
  check('  ─ 貸し出しできない', await row(rep).locator('button[data-act="lend"]').isDisabled(), true);
  check('  ─ ステッカー番号は更新されない', (await cell(rep, COL.sticker)).startsWith('STK-2026-R'), false);

  check('貸出中の残数', await page.$$eval('#invBody tr', rs => rs.filter(r => r.children[5].textContent.includes('貸出中')).length), 4);

  // 修理完了後の再点検で貸出可能に戻るか
  await row(rep).locator('button[data-act="inspect"]').click();
  await page.waitForTimeout(60);
  await page.fill('#fInsDate', TODAY);
  await page.fill('#fStickerNo', 'STK-2026-R08');
  await page.selectOption('#fInsResult', 'pass');
  await page.click('#btnConfirmInspect');
  await page.waitForTimeout(80);
  check('修理後の再点検合格で貸出可能に復帰',
        [await cell(rep, COL.status), await row(rep).locator('button[data-act="lend"]').isDisabled()], ['在庫中', false]);

  // ===== 5. 履歴 =====
  console.log('\n===== 5. 履歴の記録 =====');
  await row(ok0).locator('button[data-act="detail"]').click();
  await page.waitForTimeout(100);
  const detail = await page.evaluate(() => {
    const tables = document.querySelectorAll('#detailBody table');
    const rows = t => Array.from(t.querySelectorAll('tbody tr')).map(r => Array.from(r.children).map(c => c.textContent.trim()));
    return { rental: rows(tables[0]), inspection: rows(tables[1]) };
  });
  check('貸出履歴 1件（返却日あり）', [detail.rental.length, detail.rental[0][1], detail.rental[0][2]],
        [1, '2026/08/05', BORROWERS[0]]);
  check('点検履歴 2件（返却後点検→定期点検の順）',
        [detail.inspection.length, detail.inspection[0][1], detail.inspection[0][2], detail.inspection[1][1]],
        [2, '返却後点検', '合格', '定期点検']);
  await page.click('#overlayDetail [data-close]');

  // ===== 6. 集計と絞り込み =====
  console.log('\n===== 6. 集計・絞り込み =====');
  const capTable = await page.$$eval('#capBody tr', rs => rs.map(r => Array.from(r.children).map(c => c.textContent.trim())));
  console.log('  能力別 [荷重, 総数, 貸出可能, 貸出中, 点検待ち, 点検切れ/未点検]');
  capTable.forEach(r => console.log('   ', r.join(' / ')));
  check('能力別の総数合計', capTable.reduce((n, r) => n + Number(r[1]), 0), 30);
  check('能力別の貸出中合計', capTable.reduce((n, r) => n + Number(r[3]), 0), 4);

  await page.selectOption('#filterCapacity', '1');
  await page.waitForTimeout(80);
  check('1t で絞り込み', (await page.$$('#invBody tr')).length, 6);
  await page.selectOption('#filterMaker', 'キトー');
  await page.waitForTimeout(80);
  check('キトー × 1t で絞り込み', (await page.$$('#invBody tr')).length, 4);
  await page.selectOption('#filterMaker', '');
  await page.selectOption('#filterCapacity', '');
  await page.selectOption('#filterStatus', 'rented');
  await page.waitForTimeout(80);
  check('貸出中で絞り込み', (await page.$$('#invBody tr')).length, 4);
  await page.selectOption('#filterStatus', '');
  await page.selectOption('#filterInspection', 'expired');
  await page.waitForTimeout(80);
  check('点検切れで絞り込み', (await page.$$('#invBody tr')).length, 3);
  await page.selectOption('#filterInspection', '');
  await page.fill('#searchBox', '100014');
  await page.waitForTimeout(80);
  check('「八」なしの数字で検索', (await page.$$('#invBody tr')).length, 1);
  await page.fill('#searchBox', '');
  await page.waitForTimeout(80);

  // ===== 7. 保存とスクリーンショット =====
  await page.reload();
  await page.waitForTimeout(300);
  check('リロード後もデータが残る', (await page.$$('#invBody tr')).length, 30);
  await page.screenshot({ path: OUT + '/test30.png', fullPage: true });

  const dump = await page.evaluate(() => localStorage.getItem('chainblock_inventory_v1'));
  fs.writeFileSync(path.join(OUT, 'testdata_30.json'), JSON.stringify(JSON.parse(dump), null, 2));

  console.log(`\n===== 結果: ${pass} 件成功 / ${fail} 件失敗 =====`);
  console.log('JSエラー:', errors.length ? errors : 'なし');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
