import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '../../constants/theme';
import { useMobileStore } from '../../src/mobile/store';
import { CreatureArt, RarityBadge, Screen } from '../../src/mobile/ui';

export default function CreatureDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { catalog, gacha } = useMobileStore();
  const creature = catalog.find((item) => item.id === id);
  if (!creature) return <Screen><Text style={styles.missing}>크리처를 찾을 수 없습니다.</Text></Screen>;
  const copies = gacha.inventory.filter((item) => item.creatureId === creature.id);
  const evolution = catalog.filter((item) => {
    const sources = Array.isArray(item.evolutionFrom) ? item.evolutionFrom : [item.evolutionFrom];
    return sources.includes(creature.id) || sources.includes(creature.enName);
  });

  return (
    <Screen>
      <Stack.Screen options={{ title: creature.koName, headerStyle: { backgroundColor: colors.void }, headerTintColor: colors.ink }} />
      <View style={[styles.hero, { borderColor: `${creature.palette.glow}66` }]}>
        <CreatureArt creature={creature} size={250} />
        <RarityBadge rarity={creature.rarity} />
        <Text style={styles.name}>{creature.koName}</Text>
        <Text style={styles.english}>{creature.id} · {creature.enName} · {creature.lineageId}</Text>
      </View>
      <View style={styles.panel}>
        <Text style={styles.identity}>{creature.identity}</Text>
        <Text style={styles.lore}>{creature.lore}</Text>
      </View>
      <View style={styles.stats}>
        <Stat label="등급" value={creature.rarity} />
        <Stat label="단계" value={`${creature.stage}`} />
        <Stat label="보유" value={`${copies.length}`} />
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>SHAPE DNA</Text>
        {creature.shapeDNA.map((dna) => <Text key={dna} style={styles.dna}>◇ {dna}</Text>)}
      </View>
      <View style={styles.panel}>
        <Text style={styles.sectionTitle}>진화 신호</Text>
        <Text style={styles.lore}>{evolution.length > 0 ? `${evolution.length}개의 진화 가능성이 감지되었습니다. 먹이와 성장 성향에 따라 확률이 달라집니다.` : '현재 카탈로그에서 이어지는 진화 신호가 없습니다.'}</Text>
      </View>
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  missing: { color: colors.ink },
  hero: { backgroundColor: colors.surface, borderRadius: 24, borderWidth: 1, padding: 18, alignItems: 'center', gap: 8 },
  name: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 30 },
  english: { color: 'rgba(244,241,250,0.5)', fontFamily: fonts.mono.regular, fontSize: 10 },
  panel: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, gap: 9 },
  identity: { color: colors.ink, fontFamily: fonts.space.semiBold, fontSize: 16, lineHeight: 23 },
  lore: { color: 'rgba(244,241,250,0.62)', fontSize: 13, lineHeight: 20 },
  stats: { flexDirection: 'row', gap: 9 },
  stat: { flex: 1, backgroundColor: colors.raise, borderRadius: 13, padding: 12 },
  statValue: { color: colors.fuel, fontFamily: fonts.mono.bold, fontSize: 15 },
  statLabel: { color: 'rgba(244,241,250,0.48)', fontSize: 10, marginTop: 4 },
  sectionTitle: { color: colors.calm, fontFamily: fonts.mono.bold, fontSize: 11, letterSpacing: 1.2 },
  dna: { color: colors.ink, fontSize: 13 },
});
