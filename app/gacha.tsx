import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../constants/theme';
import { GACHA_COST } from '../src/mobile/domain';
import { useMobileStore } from '../src/mobile/store';
import { CreatureArt, RarityBadge, Screen } from '../src/mobile/ui';

export default function GachaScreen() {
  const { draw, gacha, lastDraw, activityBoost, rarityWeights, drawing } = useMobileStore();
  const [error, setError] = useState('');
  const reveal = useRef(new Animated.Value(1)).current;
  const canDraw = gacha.tokens >= GACHA_COST && !drawing;
  const handleDraw = async () => {
    try { await draw(); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : '가챠를 실행하지 못했습니다.'); }
  };
  useEffect(() => {
    if (!lastDraw) return;
    AccessibilityInfo.announceForAccessibility(`${lastDraw.creature.rarity} ${lastDraw.creature.koName} 획득${lastDraw.forcedByPity ? ', 천장 확정' : ''}${lastDraw.owned.uniqueColor ? ', 유니크 컬러' : ''}`);
    void AccessibilityInfo.isReduceMotionEnabled().then((reduceMotion) => {
      if (reduceMotion) { reveal.setValue(1); return; }
      reveal.setValue(0);
      const elite = ['ORACLE', 'ARCHITECT', 'ORIGIN'].indexOf(lastDraw.creature.rarity);
      Animated.spring(reveal, { toValue: 1, useNativeDriver: true, damping: elite === 2 ? 6 : elite === 1 ? 8 : 10, stiffness: elite >= 0 ? 86 : 130 }).start();
    });
  }, [lastDraw, reveal]);

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="가챠 화면 닫기" hitSlop={12} onPress={() => router.back()}><Text style={styles.close}>닫기</Text></Pressable>
        <Text style={styles.wallet}>{gacha.tokens.toLocaleString()} TOKEN</Text>
      </View>
      <View style={styles.intro}>
        <Text style={styles.kicker}>ACTIVITY CAPSULE</Text>
        <Text style={styles.title}>코딩의 흔적을{`\n`}새 생명으로</Text>
        <Text style={styles.description}>활동 보너스 {Math.round(activityBoost * 100)}% 적용 · 유니크 컬러 확률 0.1%</Text>
        <Text style={styles.odds}>{Object.entries(rarityWeights).map(([rarity, weight]) => `${rarity} ${weight.toFixed(1)}%`).join(' · ')}</Text>
      </View>

      {lastDraw ? (
        <Animated.View accessible accessibilityRole="summary" accessibilityLiveRegion="polite" accessibilityLabel={`${lastDraw.creature.rarity} ${lastDraw.creature.koName} 획득`} style={[styles.result, { borderColor: lastDraw.creature.palette.glow, shadowColor: lastDraw.creature.palette.glow, shadowOpacity: ['ORACLE', 'ARCHITECT', 'ORIGIN'].includes(lastDraw.creature.rarity) ? 0.9 : 0.5, opacity: reveal, transform: [{ scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [['ORIGIN'].includes(lastDraw.creature.rarity) ? 0.45 : ['ARCHITECT'].includes(lastDraw.creature.rarity) ? 0.58 : ['ORACLE'].includes(lastDraw.creature.rarity) ? 0.68 : 0.78, 1] }) }] }]}>
          <View style={lastDraw.owned.uniqueColor && styles.uniqueArt}><CreatureArt creature={lastDraw.creature} size={230} /></View>
          <RarityBadge rarity={lastDraw.creature.rarity} />
          <Text style={styles.resultName}>{lastDraw.creature.koName}</Text>
          <Text style={styles.resultMeta}>{lastDraw.creature.id} · {lastDraw.creature.enName}</Text>
          {lastDraw.forcedByPity ? <Text style={styles.pityWin}>천장 확정 등장</Text> : null}
          {lastDraw.owned.uniqueColor ? <Text style={styles.unique}>✦ UNIQUE COLOR</Text> : null}
        </Animated.View>
      ) : (
        <View style={styles.capsule}><View style={styles.capsuleCore} /><Text style={styles.question}>?</Text></View>
      )}

      <View style={styles.pityCard}>
        <View style={styles.pityRow}><Text style={styles.pityTitle}>ORIGIN 천장</Text><Text style={styles.pityCount}>{gacha.pity} / 300</Text></View>
        <View style={styles.track}><View style={[styles.fill, { width: `${gacha.pity / 3}%` }]} /></View>
        <Text style={styles.pityHelp}>300회 연속 미등장 시 다음 1회에서 ORIGIN 확정</Text>
      </View>

      <Pressable accessibilityRole="button" accessibilityLabel="50만 토큰으로 가챠 실행" accessibilityState={{ disabled: !canDraw, busy: drawing }} disabled={!canDraw} onPress={handleDraw} style={[styles.draw, !canDraw && styles.drawDisabled]}>
        <Text style={styles.drawText}>{drawing ? '신호 해독 중…' : `${lastDraw ? '한 번 더 뽑기' : '가챠 시작'} · 500,000`}</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.disclosure}>현금 결제·환급·판매·양도 없이 실제 코딩 활동으로 얻은 무료 토큰만 사용합니다.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  close: { color: colors.calm, fontFamily: fonts.space.semiBold, fontSize: 14 },
  wallet: { color: colors.fuel, fontFamily: fonts.mono.bold, fontSize: 12 },
  intro: { alignItems: 'center', gap: 7, paddingVertical: 5 },
  kicker: { color: colors.rival, fontFamily: fonts.mono.bold, fontSize: 11, letterSpacing: 1.5 },
  title: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 30, textAlign: 'center', lineHeight: 36 },
  description: { color: 'rgba(244,241,250,0.52)', fontSize: 11 },
  odds: { color: 'rgba(244,241,250,0.58)', fontFamily: fonts.mono.regular, fontSize: 11, textAlign: 'center', lineHeight: 17, maxWidth: 350 },
  capsule: { height: 280, borderRadius: 32, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  capsuleCore: { position: 'absolute', width: 170, height: 170, borderRadius: 85, backgroundColor: colors.rival, opacity: 0.24 },
  question: { color: colors.ink, fontFamily: fonts.mono.bold, fontSize: 80 },
  result: { borderWidth: 1, borderRadius: 28, backgroundColor: colors.surface, alignItems: 'center', padding: 18, gap: 7, shadowOpacity: 0.5, shadowRadius: 22, shadowOffset: { width: 0, height: 0 }, elevation: 10 },
  resultName: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 28 },
  resultMeta: { color: 'rgba(244,241,250,0.5)', fontFamily: fonts.mono.regular, fontSize: 10 },
  pityWin: { color: colors.rare, fontFamily: fonts.mono.bold, fontSize: 11 },
  unique: { color: colors.fuel, fontFamily: fonts.mono.bold, fontSize: 11 },
  uniqueArt: { borderWidth: 2, borderColor: colors.fuel, borderRadius: 120, shadowColor: colors.rival, shadowOpacity: 0.8, shadowRadius: 24 },
  pityCard: { backgroundColor: colors.raise, borderRadius: 15, padding: 14, gap: 8 },
  pityRow: { flexDirection: 'row', justifyContent: 'space-between' },
  pityTitle: { color: colors.ink, fontFamily: fonts.space.semiBold, fontSize: 13 },
  pityCount: { color: colors.rare, fontFamily: fonts.mono.bold, fontSize: 12 },
  track: { height: 7, borderRadius: 99, backgroundColor: colors.surface, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.rare },
  pityHelp: { color: 'rgba(244,241,250,0.45)', fontSize: 10 },
  draw: { backgroundColor: colors.fuel, borderRadius: 16, paddingVertical: 16, alignItems: 'center' },
  drawDisabled: { opacity: 0.35 },
  drawText: { color: colors.void, fontFamily: fonts.space.bold, fontSize: 15 },
  error: { color: colors.rival, textAlign: 'center' },
  disclosure: { color: 'rgba(244,241,250,0.4)', fontSize: 10, textAlign: 'center', lineHeight: 15 },
});
