import { Href, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../../constants/theme';
import { weeklyTotal } from '../../src/mobile/domain';
import { useMobileStore } from '../../src/mobile/store';
import { CreatureArt, formatTokens, RarityBadge, Screen } from '../../src/mobile/ui';

export default function NestScreen() {
  const { catalog, feed, gacha, selected, weeklyUsage: WEEKLY_USAGE, error, loading, ready, refresh, selectCreature } = useMobileStore();
  const creature = catalog.find((item) => item.id === selected.creatureId) ?? catalog[0];
  const hasCreature = gacha.inventory.length > 0;
  const availableFeed = feed.filter((item) => !item.consumed);
  const maxUsage = Math.max(1, ...WEEKLY_USAGE.map((day) => day.claude + day.codex));

  if (loading) return <Screen><View style={styles.loading}><Text style={styles.loadingText}>둥지를 불러오는 중…</Text></View></Screen>;
  if (!ready) return <Screen><View style={styles.loading}><Text style={styles.errorTitle}>둥지를 불러오지 못했어요</Text><Text style={styles.emptyCopy}>{error}</Text><Pressable accessibilityRole="button" onPress={() => void refresh()} style={styles.retry}><Text style={styles.darkActionText}>다시 시도</Text></Pressable></View></Screen>;

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>PunchGrow<Text style={styles.dot}>.</Text></Text>
          <Text style={styles.wallet}>{gacha.tokens.toLocaleString()} TOKEN</Text>
        </View>
        <View style={styles.streak}><Text style={styles.streakText}>LOCAL MVP</Text></View>
      </View>
      {error ? <Text style={{ color: colors.rare, marginBottom: 10 }}>서버 연결: {error}</Text> : null}

      {hasCreature ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`${creature.koName} 상세 보기`} style={styles.creatureCard} onPress={() => router.push(`/creature/${creature.id}` as Href)}>
          <View style={selected.uniqueColor && styles.uniqueFrame}><CreatureArt creature={creature} size={178} /></View>
          <View style={styles.creatureInfo}>
            <View style={styles.badgeRow}><RarityBadge rarity={creature.rarity} />{selected.uniqueColor ? <Text style={styles.uniqueLabel}>✦ UNIQUE</Text> : null}</View>
            <View style={styles.nameRow}><Text style={styles.name}>{creature.koName}</Text><Text style={styles.level}>LV {selected.level}</Text></View>
            <Text style={styles.identity}>{creature.identity}</Text>
            <View style={styles.progress}><View style={[styles.progressFill, { width: `${selected.xp % 1_000 / 10}%` }]} /></View>
            <Text style={styles.progressText}>다음 레벨까지 {1_000 - selected.xp % 1_000} XP · 포만도 {selected.hunger}%</Text>
          </View>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="첫 크리처 뽑기" style={[styles.creatureCard, styles.emptyNest]} onPress={() => router.push('/gacha' as Href)}>
          <View style={styles.emptyCapsule}><Text style={styles.emptyMark}>?</Text></View>
          <Text style={styles.emptyTitle}>아직 깨어난 크리처가 없어요</Text>
          <Text style={styles.emptyCopy}>코딩 토큰으로 첫 활동 캡슐을 열어보세요.</Text>
        </Pressable>
      )}

      {gacha.inventory.length > 1 ? <View style={styles.switcher}>
        <Text style={styles.kicker}>대표 크리처 선택</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.switcherRow}>
          {gacha.inventory.map((item) => {
            const species = catalog.find((entry) => entry.id === item.creatureId);
            return <Pressable key={item.instanceId} accessibilityRole="button" accessibilityState={{ selected: item.instanceId === selected.instanceId }} onPress={() => selectCreature(item.instanceId)} style={[styles.switchButton, item.instanceId === selected.instanceId && styles.switchButtonActive]}><Text style={styles.switchText}>{species?.koName ?? item.creatureId} · LV{item.level}</Text></Pressable>;
          })}
        </ScrollView>
      </View> : null}

      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel={hasCreature ? `먹이 주기, 대기 ${availableFeed.length}개` : '크리처 획득 후 먹이 주기 가능'} accessibilityState={{ disabled: !hasCreature }} disabled={!hasCreature} style={[styles.action, styles.feedAction, !hasCreature && styles.disabledAction]} onPress={() => router.push('/(tabs)/feed')}>
          <Text style={styles.darkActionText}>먹이 주기 · {availableFeed.length}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="가챠 열기, 50만 토큰" style={[styles.action, styles.gachaAction]} onPress={() => router.push('/gacha' as Href)}>
          <Text style={styles.actionText}>가챠 · 50만</Text>
        </Pressable>
      </View>

      <View style={styles.inventoryLine}>
        <Text style={styles.inventoryTitle}>보유 개체 {gacha.inventory.length}</Text>
        <Text style={styles.inventoryMeta}>ORIGIN 천장 {gacha.pity} / 300</Text>
      </View>

      <View accessible accessibilityLabel={`금주 토큰 사용량 ${weeklyTotal(WEEKLY_USAGE).toLocaleString()}, Claude ${WEEKLY_USAGE.reduce((sum, day) => sum + day.claude, 0).toLocaleString()}, Codex ${WEEKLY_USAGE.reduce((sum, day) => sum + day.codex, 0).toLocaleString()}`} style={styles.usageCard}>
        <View style={styles.rowBetween}>
          <View><Text style={styles.kicker}>금주 토큰 사용량</Text><Text style={styles.usageTotal}>{formatTokens(weeklyTotal(WEEKLY_USAGE))}</Text></View>
          <View style={styles.legend}><Text style={styles.claude}>● Claude</Text><Text style={styles.codex}>● Codex</Text></View>
        </View>
        <View style={styles.chart}>
          {WEEKLY_USAGE.map((day) => {
            const total = day.claude + day.codex;
            const height = Math.max(14, (total / maxUsage) * 82);
            const claudeRatio = total > 0 ? day.claude / total : 0.5;
            return <View key={day.day} style={styles.dayColumn}>
              <View style={[styles.bar, { height }]}><View style={[styles.codexBar, { flex: 1 - claudeRatio }]} /><View style={[styles.claudeBar, { flex: claudeRatio }]} /></View>
              <Text style={styles.dayLabel}>{day.day}</Text>
            </View>;
          })}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 24 },
  dot: { color: colors.fuel },
  wallet: { color: colors.fuel, fontFamily: fonts.mono.bold, fontSize: 12, marginTop: 4 },
  streak: { backgroundColor: 'rgba(255,184,77,0.14)', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 7 },
  streakText: { color: colors.rare, fontFamily: fonts.mono.medium, fontSize: 11 },
  usageCard: { backgroundColor: colors.surface, borderRadius: 20, padding: 17, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  kicker: { color: 'rgba(244,241,250,0.58)', fontSize: 12 },
  usageTotal: { color: colors.ink, fontFamily: fonts.mono.bold, fontSize: 24, marginTop: 4 },
  legend: { alignItems: 'flex-end', gap: 4 },
  claude: { color: colors.calm, fontFamily: fonts.mono.regular, fontSize: 9 },
  codex: { color: colors.rival, fontFamily: fonts.mono.regular, fontSize: 9 },
  chart: { height: 110, flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 13 },
  dayColumn: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center', gap: 6 },
  bar: { width: '76%', maxWidth: 34, borderRadius: 7, overflow: 'hidden', flexDirection: 'column' },
  claudeBar: { backgroundColor: colors.calm },
  codexBar: { backgroundColor: colors.rival },
  dayLabel: { color: 'rgba(244,241,250,0.48)', fontFamily: fonts.mono.regular, fontSize: 9 },
  creatureCard: { backgroundColor: colors.surface, borderRadius: 24, padding: 18, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(198,248,78,0.2)' },
  creatureInfo: { width: '100%', gap: 9 },
  uniqueFrame: { borderWidth: 2, borderColor: colors.fuel, borderRadius: 90, shadowColor: colors.rival, shadowOpacity: 0.75, shadowRadius: 18 },
  badgeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  uniqueLabel: { color: colors.fuel, fontFamily: fonts.mono.bold, fontSize: 10 },
  emptyNest: { minHeight: 310, justifyContent: 'center', gap: 10 },
  emptyCapsule: { width: 142, height: 142, borderRadius: 71, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(157,77,255,0.2)', borderWidth: 1, borderColor: 'rgba(198,248,78,0.35)' },
  emptyMark: { color: colors.fuel, fontFamily: fonts.mono.bold, fontSize: 56 },
  emptyTitle: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 21 },
  emptyCopy: { color: 'rgba(244,241,250,0.58)', fontSize: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 26 },
  level: { color: colors.calm, fontFamily: fonts.mono.bold, fontSize: 12 },
  identity: { color: 'rgba(244,241,250,0.62)', fontSize: 13, lineHeight: 19 },
  progress: { height: 9, backgroundColor: colors.raise, borderRadius: 99, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.fuel, borderRadius: 99 },
  progressText: { color: 'rgba(244,241,250,0.48)', fontFamily: fonts.mono.regular, fontSize: 10 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, borderRadius: 15, paddingVertical: 15, alignItems: 'center' },
  feedAction: { backgroundColor: colors.fuel },
  gachaAction: { backgroundColor: colors.rival },
  darkActionText: { color: colors.void, fontFamily: fonts.space.bold, fontSize: 14 },
  actionText: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 14 },
  disabledAction: { opacity: 0.35 },
  inventoryLine: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.raise, borderRadius: 12, padding: 13 },
  inventoryTitle: { color: colors.ink, fontFamily: fonts.mono.bold, fontSize: 11 },
  inventoryMeta: { color: colors.rare, fontFamily: fonts.mono.regular, fontSize: 11 },
  loading: { minHeight: 420, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: colors.calm, fontFamily: fonts.mono.medium },
  errorTitle: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 20 },
  retry: { backgroundColor: colors.fuel, borderRadius: 14, minHeight: 44, paddingHorizontal: 20, justifyContent: 'center' },
  switcher: { gap: 8 },
  switcherRow: { gap: 8 },
  switchButton: { minHeight: 44, justifyContent: 'center', backgroundColor: colors.raise, borderRadius: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: 'transparent' },
  switchButtonActive: { borderColor: colors.fuel },
  switchText: { color: colors.ink, fontFamily: fonts.mono.medium, fontSize: 10 },
});
