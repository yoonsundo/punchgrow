import { Tabs } from 'expo-router';
import { ColorValue, Text } from 'react-native';

import { colors } from '../../constants/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.void,
          borderTopColor: 'rgba(255,255,255,0.08)',
        },
        tabBarActiveTintColor: colors.fuel,
        tabBarInactiveTintColor: colors.ink,
      }}
    >
      <Tabs.Screen name="index" options={{ title: '둥지', tabBarIcon: ({ color }) => <TabIcon symbol="◆" color={color} /> }} />
      <Tabs.Screen name="feed" options={{ title: '먹이', tabBarIcon: ({ color }) => <TabIcon symbol="✦" color={color} /> }} />
      <Tabs.Screen name="arena" options={{ title: '아레나', tabBarIcon: ({ color }) => <TabIcon symbol="⚔" color={color} /> }} />
      <Tabs.Screen name="dex" options={{ title: '도감', tabBarIcon: ({ color }) => <TabIcon symbol="▦" color={color} /> }} />
      <Tabs.Screen name="me" options={{ title: '나', tabBarIcon: ({ color }) => <TabIcon symbol="●" color={color} /> }} />
    </Tabs>
  );
}

function TabIcon({ symbol, color }: { symbol: string; color: ColorValue }) {
  return <Text aria-hidden style={{ color, fontSize: 15 }}>{symbol}</Text>;
}
