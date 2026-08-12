import { PropsWithChildren } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts } from '../../constants/theme';
import { CreatureCatalogEntry, Rarity } from './domain';
import { creatureImages } from './creature-images';

export const rarityColors: Record<Rarity, string> = {
  PROCESS: '#7BE3C3',
  AGENT: '#62B7FF',
  DAEMON: '#B890FF',
  ORACLE: '#FF79C9',
  ARCHITECT: '#FFB84D',
  ORIGIN: '#FFF2A8',
};

export function Screen({ children }: PropsWithChildren) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function ScreenTitle({ eyebrow, children }: PropsWithChildren<{ eyebrow?: string }>) {
  return (
    <View style={styles.heading}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <Text style={styles.title}>{children}</Text>
    </View>
  );
}

export function CreatureArt({ creature, size = 150 }: { creature: CreatureCatalogEntry; size?: number }) {
  const source = creatureImages[creature.id];
  if (source) {
    return <Image source={source} resizeMode="contain" style={{ width: size, height: size }} accessibilityLabel={`${creature.koName} 이미지`} />;
  }
  return (
    <View style={[styles.artFallback, { width: size, height: size, borderColor: creature.palette.glow }]}>
      <View style={[styles.artCore, { backgroundColor: creature.palette.primary }]} />
      <Text style={[styles.artLabel, { color: creature.palette.secondary }]}>{creature.id.slice(3)}</Text>
    </View>
  );
}

export function RarityBadge({ rarity }: { rarity: Rarity }) {
  return (
    <View style={[styles.badge, { borderColor: rarityColors[rarity] }]}>
      <Text style={[styles.badgeText, { color: rarityColors[rarity] }]}>{rarity}</Text>
    </View>
  );
}

export function formatTokens(value: number) {
  return new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.void },
  content: { padding: 20, paddingBottom: 42, gap: 16, width: '100%', maxWidth: 760, alignSelf: 'center' },
  heading: { gap: 4 },
  eyebrow: { color: colors.calm, fontFamily: fonts.mono.bold, fontSize: 11, letterSpacing: 1.4 },
  title: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 28 },
  artFallback: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 28, backgroundColor: colors.raise, overflow: 'hidden' },
  artCore: { position: 'absolute', width: '64%', height: '64%', borderRadius: 999, opacity: 0.8, transform: [{ rotate: '24deg' }] },
  artLabel: { fontFamily: fonts.mono.bold, fontSize: 22 },
  badge: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5 },
  badgeText: { fontFamily: fonts.mono.bold, fontSize: 10 },
});
