import { Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppFonts } from '../hooks/useAppFonts';
import { colors, fonts } from '../constants/theme';
import { MobileStoreProvider, useMobileStore } from '../src/mobile/store';
import { Screen } from '../src/mobile/ui';

export default function RootLayout() {
  const fontsLoaded = useAppFonts();

  if (!fontsLoaded) {
    return null;
  }

  return (
    <MobileStoreProvider>
      <AppStack />
    </MobileStoreProvider>
  );
}

function AppStack() {
  const { loading, ready, error, refresh } = useMobileStore();
  if (loading) return <Screen><View style={styles.state}><Text style={styles.copy}>PunchGrow 데이터를 불러오는 중…</Text></View></Screen>;
  if (!ready) return <Screen><View style={styles.state}><Text style={styles.title}>데이터를 불러오지 못했어요</Text><Text style={styles.copy}>{error}</Text><Pressable accessibilityRole="button" onPress={() => void refresh()} style={styles.retry}><Text style={styles.retryText}>다시 시도</Text></Pressable></View></Screen>;
  return <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="gacha" options={{ headerShown: false, presentation: 'modal' }} />
      </Stack>;
}

const styles = StyleSheet.create({
  state: { minHeight: 520, justifyContent: 'center', alignItems: 'center', gap: 12 },
  title: { color: colors.ink, fontFamily: fonts.space.bold, fontSize: 22 },
  copy: { color: colors.calm, textAlign: 'center', fontSize: 14 },
  retry: { minHeight: 44, justifyContent: 'center', borderRadius: 14, backgroundColor: colors.fuel, paddingHorizontal: 22 },
  retryText: { color: colors.void, fontFamily: fonts.space.bold },
});
