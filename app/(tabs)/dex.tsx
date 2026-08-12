import { Href, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts } from '../../constants/theme';
import { RARITIES, Rarity } from '../../src/mobile/domain';
import { useMobileStore } from '../../src/mobile/store';
import { CreatureArt, rarityColors, ScreenTitle } from '../../src/mobile/ui';

type Filter = 'ALL' | 'UNIQUE' | Rarity;

export default function DexScreen() {
  const { catalog, gacha } = useMobileStore();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const { width } = useWindowDimensions();
  const columns = width >= 700 ? 4 : width >= 480 ? 3 : 2;
  const ownedIds = useMemo(() => new Set(gacha.inventory.map((item) => item.creatureId)), [gacha.inventory]);
  const uniqueIds = useMemo(() => new Set(gacha.inventory.filter((item) => item.uniqueColor).map((item) => item.creatureId)), [gacha.inventory]);
  const shown = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ko-KR');
    return catalog.filter((item) => (filter === 'ALL' || (filter === 'UNIQUE' ? uniqueIds.has(item.id) : item.rarity === filter))
      && (!normalized || `${item.id} ${item.koName} ${item.enName}`.toLocaleLowerCase('ko-KR').includes(normalized)));
  }, [catalog, filter, query, uniqueIds]);

  const header = <View style={styles.header}>
    <ScreenTitle eyebrow="240 CREATURES">크리처 도감</ScreenTitle>
    <TextInput value={query} onChangeText={setQuery} placeholder="이름 또는 PG-### 검색" placeholderTextColor="rgba(244,241,250,0.36)" style={styles.search} />
    <View style={styles.filters}>{(['ALL', 'UNIQUE', ...RARITIES] as Filter[]).map((rarity) => (
      <Pressable key={rarity} accessibilityRole="button" accessibilityState={{ selected: filter === rarity }} onPress={() => setFilter(rarity)} style={[styles.filter, filter === rarity && styles.filterActive]}>
        <Text style={[styles.filterText, filter === rarity && styles.filterTextActive]}>{rarity === 'ALL' ? '전체' : rarity === 'UNIQUE' ? '변이' : rarity}</Text>
      </Pressable>
    ))}</View>
    <View style={styles.countRow}><Text style={styles.count}>{shown.length} / {catalog.length}종</Text><Text style={styles.owned}>획득 {ownedIds.size}종 · 변이 {uniqueIds.size}종</Text></View>
  </View>;

  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
    <FlatList key={columns} data={shown} numColumns={columns} keyExtractor={(item) => item.id} ListHeaderComponent={header}
      contentContainerStyle={styles.content} columnWrapperStyle={styles.row} initialNumToRender={12} windowSize={7} removeClippedSubviews
      renderItem={({ item: creature }) => {
        const owned = ownedIds.has(creature.id);
        const unique = uniqueIds.has(creature.id);
        return <Pressable accessibilityRole="button" accessibilityLabel={owned ? `${creature.koName} 상세 보기` : '미발견 크리처'} accessibilityState={{ disabled: !owned }} disabled={!owned}
          onPress={() => router.push(`/creature/${creature.id}` as Href)} style={[styles.card, { borderColor: `${rarityColors[creature.rarity]}55` }]}>
          {owned ? <CreatureArt creature={creature} size={width >= 700 ? 112 : 128} /> : <View accessible={false} style={styles.silhouette}><Text style={styles.question}>?</Text></View>}
          <Text style={[styles.cardId, { color: owned ? rarityColors[creature.rarity] : 'rgba(244,241,250,.35)' }]}>{owned ? `${creature.id} · ${creature.rarity}` : 'PG-??? · UNKNOWN'}</Text>
          <Text style={styles.cardName}>{owned ? creature.koName : '미발견'}</Text>
          {unique ? <Text style={styles.unique}>✦ UNIQUE VARIANT</Text> : null}
          <Text style={styles.cardMeta}>{owned ? `${creature.stage}단계 · ${creature.bodyForm}` : '획득 후 정보 공개'}</Text>
        </Pressable>;
      }} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.void }, content: { padding: 20, paddingBottom: 42, maxWidth: 760, width: '100%', alignSelf: 'center' }, header: { gap: 16, marginBottom: 8 }, row: { gap: 8 },
  search: { backgroundColor: colors.surface, borderRadius: 13, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', color: colors.ink, fontFamily: fonts.space.regular, fontSize: 14, paddingHorizontal: 14, paddingVertical: 12 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, filter: { minHeight: 44, justifyContent: 'center', borderRadius: 99, backgroundColor: colors.raise, paddingHorizontal: 10 }, filterActive: { backgroundColor: colors.fuel }, filterText: { color: 'rgba(244,241,250,0.62)', fontFamily: fonts.mono.bold, fontSize: 9 }, filterTextActive: { color: colors.void },
  countRow: { flexDirection: 'row', justifyContent: 'space-between' }, count: { color: 'rgba(244,241,250,0.5)', fontFamily: fonts.mono.regular, fontSize: 11 }, owned: { color: colors.fuel, fontFamily: fonts.mono.regular, fontSize: 11 },
  card: { flex: 1, margin: 4, backgroundColor: colors.surface, borderWidth: 1, borderRadius: 17, padding: 10, minWidth: 0, alignItems: 'center' }, silhouette: { width: 128, height: 128, borderRadius: 64, backgroundColor: colors.raise, alignItems: 'center', justifyContent: 'center' }, question: { color: 'rgba(244,241,250,.25)', fontFamily: fonts.mono.bold, fontSize: 48 },
  cardId: { width: '100%', fontFamily: fonts.mono.bold, fontSize: 8, marginTop: 7 }, cardName: { width: '100%', color: colors.ink, fontFamily: fonts.space.bold, fontSize: 15, marginTop: 4 }, cardMeta: { width: '100%', color: 'rgba(244,241,250,0.45)', fontSize: 9, marginTop: 3 },
  unique: { width: '100%', color: colors.fuel, fontFamily: fonts.mono.bold, fontSize: 8, marginTop: 3 },
});
