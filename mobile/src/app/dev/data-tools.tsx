// 数据工具（M4 开发入口）：一致性扫描 / 孤儿清理 / 缩略图重建 / 存储与 schema 信息。
// 只读操作为主；清理需二次确认。升级演练的 Node 回归见 mobile/tests/analysisMigration.test.cjs，
// 加密抽检走 adb（文件头检查），本页不做伪装验证。

import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { File, Paths } from 'expo-file-system';
import { Page } from '../../ui/Screen';
import { BackTitle } from '../../ui/PageTop';
import { Button } from '../../ui/components/Button';
import { useToast } from '../../ui/components/Toast';
import {
  cleanOrphanFiles,
  exportWardrobeProfiles,
  getFreeDiskBytes,
  MIN_FREE_BYTES_FOR_PHOTO,
  rebuildMissingThumbnails,
  scanConsistency,
  type ConsistencyReport,
} from '../../data/repositories/maintenanceRepository';
import { getDb, schemaMigrations } from '../../data/db';
import { colors, type } from '../../ui/tokens';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export default function DataToolsScreen() {
  const router = useRouter();
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<ConsistencyReport | null>(null);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const [next, free, db] = [await scanConsistency(), await getFreeDiskBytes(), await getDb()];
      const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      setReport(next);
      setFreeBytes(free);
      setSchemaVersion(row?.user_version ?? null);
    } catch (error) {
      toast(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setScanning(false);
    }
  }, [toast]);

  function confirmCleanOrphans() {
    if (!report || report.orphanFiles.length === 0) return;
    Alert.alert(
      '清理孤儿文件？',
      `将删除 ${report.orphanFiles.length} 个没有任何照片记录引用的文件（已逐项核对引用）。此操作不可恢复。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清理',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                const { deleted } = await cleanOrphanFiles();
                toast(`已清理 ${deleted.length} 个文件`);
                await scan();
              } catch (error) {
                toast(`清理失败：${error instanceof Error ? error.message : String(error)}`);
              }
            })();
          },
        },
      ],
    );
  }

  function confirmRebuildThumbs() {
    if (!report || report.rebuildableThumbs.length === 0) return;
    const count = report.rebuildableThumbs.length;
    void (async () => {
      try {
        const { rebuilt, failed } = await rebuildMissingThumbnails();
        toast(failed.length === 0 ? `已重建 ${rebuilt.length} 张缩略图` : `重建 ${rebuilt.length} 张，失败 ${failed.length} 张`);
        await scan();
      } catch (error) {
        toast(`重建失败：${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  async function exportProfiles() {
    try {
      const profile = await exportWardrobeProfiles();
      const file = new File(Paths.document, 'wardrobe-profile.json');
      if (file.exists) file.delete();
      file.write(JSON.stringify(profile, null, 2));
      toast(`已导出 ${profile.items.length} 件衣物的档案（documents/wardrobe-profile.json）`);
    } catch (error) {
      toast(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const hasIssues =
    report != null &&
    (report.missingFiles.length > 0 ||
      report.danglingMainRefs.length > 0 ||
      report.orphanFiles.length > 0 ||
      report.rebuildableThumbs.length > 0);

  return (
    <Page>
      <BackTitle title="数据工具（开发）" onBack={() => router.back()} />

      <Text style={styles.sectionTitle}>存储</Text>
      <Text style={styles.note}>
        {freeBytes == null
          ? '尚未读取可用空间。'
          : `可用空间 ${formatBytes(freeBytes)}；保存新照片要求 ≥ ${formatBytes(MIN_FREE_BYTES_FOR_PHOTO)}。`}
      </Text>

      <Text style={styles.sectionTitle}>数据库 schema</Text>
      <Text style={styles.note}>
        当前 user_version：{schemaVersion ?? '未读取'}；迁移步骤：
        {schemaMigrations.map((step) => ` v${step.version}`).join(' →')}
        。升级演练与失败注入的回归见仓库 mobile/tests/analysisMigration.test.cjs。
      </Text>

      <Button variant="primary" label={scanning ? '扫描中…' : '运行一致性扫描'} onPress={() => void scan()} />

      {report ? (
        <View style={styles.report}>
          <Text style={styles.sectionTitle}>扫描结果</Text>
          <Text style={styles.note}>
            {hasIssues
              ? [
                  `文件缺失 ${report.missingFiles.length} 条`,
                  `悬空主图引用 ${report.danglingMainRefs.length} 条`,
                  `孤儿文件 ${report.orphanFiles.length} 个`,
                  `可重建缩略图 ${report.rebuildableThumbs.length} 张`,
                ].join('；')
              : '全部健康：引用完整、无孤儿文件、无缺失缩略图。'}
          </Text>

          {report.missingFiles.slice(0, 5).map((entry) => (
            <Text key={entry.photoId} style={styles.detail}>
              {`缺失 ${entry.missing.join('+')} · ${entry.photoId}（${entry.itemId}）`}
            </Text>
          ))}
          {report.danglingMainRefs.slice(0, 5).map((entry) => (
            <Text key={entry.itemId} style={styles.detail}>
              {`悬空主图 · ${entry.itemId} → ${entry.mainPhotoId}`}
            </Text>
          ))}
          {report.orphanFiles.slice(0, 5).map((path) => (
            <Text key={path} style={styles.detail}>
              {`孤儿文件 · ${path}`}
            </Text>
          ))}

          {report.orphanFiles.length > 0 ? (
            <Button
              variant="secondary"
              label={`清理孤儿文件（${report.orphanFiles.length} 个）`}
              onPress={confirmCleanOrphans}
              style={styles.gap}
            />
          ) : null}
          {report.rebuildableThumbs.length > 0 ? (
            <Button
              variant="secondary"
              label={`重建缺失缩略图（${report.rebuildableThumbs.length} 张）`}
              onPress={confirmRebuildThumbs}
              style={styles.gap}
            />
          ) : null}
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>衣物档案导出</Text>
      <Text style={styles.note}>
        导出结构化档案 JSON（名称、品类、动态属性、颜色、测量），不含照片。用于搭配推荐实验与调试。
      </Text>
      <Button variant="secondary" label="导出档案 JSON" onPress={() => void exportProfiles()} />
    </Page>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    ...type.sectionHead,
    color: colors.ink,
    marginTop: 20,
    marginBottom: 6,
  },
  note: {
    ...type.footnote,
    color: colors.muted,
    lineHeight: 20,
    marginBottom: 10,
  },
  detail: {
    ...type.footnote,
    color: colors.ink,
    lineHeight: 20,
  },
  report: {
    marginTop: 4,
  },
  gap: {
    marginTop: 12,
  },
});
