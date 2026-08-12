import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';

import { colors, fonts } from '../../constants/theme';
import { weeklyTotal } from '../../src/mobile/domain';
import { useMobileStore } from '../../src/mobile/store';
import { formatTokens, Screen, ScreenTitle } from '../../src/mobile/ui';

export default function FeedScreen() {
  const { catalog, feed, feedCreature, selected, gacha, weeklyUsage: WEEKLY_USAGE, feeding } = useMobileStore();
  const hasCreature = gacha.inventory.length > 0;
  const selectedSpecies = catalog.find((item) => item.id === selected.creatureId);
  const [error, setError] = useState('');
  const handleFeed = async (eventID: string) => {
    try { await feedCreature(eventID); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '먹이 처리를 완료하지 못했습니다.'); }
  };
  return (
    <Screen>
      <ScreenTitle eyebrow="ACTIVITY → GROWTH">먹이 기록</ScreenTitle>
      <View style={styles.summary}>
        <Text style={styles.summaryLabel}>이번 주 실제 사용량</Text>
        <Text style={styles.summaryValue}>{formatTokens(weeklyTotal(WEEKLY_USAGE))} tokens</Text>
        <Text style={styles.summaryMeta}>{hasCreature ? `먹이 대상: ${selectedSpecies?.koName ?? selected.creatureId} · LV ${selected.level} · ${selected.instanceId.slice(0, 6)} · 누적 ${selected.xp.toLocaleString()} XP${selected.uniqueColor ? ' · UNIQUE' : ''}` : '크리처를 먼저 획득하면 먹이 활동을 시작할 수 있습니다.'}</Text>
      </View>
      <Text style={styles.section}>먹이 대기열</Text>
      {feed.map((event) => (
        <View key={event.id} style={[styles.event, event.consumed && styles.consumed]}>
          <View style={[styles.source, event.source === 'Claude Code' ? styles.claude : styles.codex]}>
            <Text style={styles.sourceText}>{event.source === 'Claude Code' ? 'CC' : 'CX'}</Text>
          </View>
          <View style={styles.eventBody}>
            <Text style={styles.eventTitle}>{event.source} · {event.title}</Text>
            <Text style={styles.eventMeta}>{event.tokens.toLocaleString()} tokens → +{event.xp} XP</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={`${event.source} ${event.title} 먹이 주기`} accessibilityState={{ disabled: !hasCreature || event.consumed || feeding, busy: feeding }} disabled={!hasCreature || event.consumed || feeding} onPress={() => void handleFeed(event.id)} style={[styles.button, (!hasCreature || event.consumed || feeding) && styles.buttonDisabled]}>
            <Text style={styles.buttonText}>{feeding ? '처리 중' : event.consumed ? '완료' : hasCreature ? '먹이' : '잠김'}</Text>
          </Pressable>
        </View>
      ))}
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      <View style={styles.notice}><Text style={styles.noticeText}>프롬프트·소스코드·명령 내용은 저장하지 않고 사용량 숫자만 성장에 반영합니다.</Text></View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { backgroundColor: colors.surface, borderRadius: 20, padding: 18, gap: 5 },
  summaryLabel: { color: 'rgba(244,241,250,0.55)', fontSize: 12 },
  summaryValue: { color: colors.fuel, fontFamily: fonts.mono.bold, fontSize: 26 },
  summaryMeta: { color: colors.ink, fontFamily: fonts.mono.regular, fontSize: 11 },
  section: { color: colors.ink, fontFamily: fonts.space.semiBold, fontSize: 16, marginTop: 4 },
  event: { backgroundColor: colors.surface, borderRadius: 15, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 11 },
  consumed: { opacity: 0.5 },
  source: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  claude: { backgroundColor: 'rgba(77,225,255,0.16)' },
  codex: { backgroundColor: 'rgba(255,77,157,0.16)' },
  sourceText: { color: colors.ink, fontFamily: fonts.mono.bold, fontSize: 11 },
  eventBody: { flex: 1, gap: 4 },
  eventTitle: { color: colors.ink, fontSize: 13 },
  eventMeta: { color: 'rgba(244,241,250,0.55)', fontFamily: fonts.mono.regular, fontSize: 10 },
  button: { backgroundColor: colors.fuel, borderRadius: 10, paddingHorizontal: 13, minHeight: 44, justifyContent: 'center' },
  buttonDisabled: { backgroundColor: colors.raise },
  buttonText: { color: colors.void, fontFamily: fonts.space.bold, fontSize: 12 },
  notice: { borderWidth: 1, borderColor: 'rgba(77,225,255,0.25)', borderRadius: 13, padding: 13 },
  noticeText: { color: 'rgba(244,241,250,0.62)', fontSize: 12, lineHeight: 18 },
  error: { color: colors.rival, textAlign: 'center', fontSize: 12 },
});
