// `register` must be imported before React renders so the DevTools hook sees the roots.
import '../src/register';
import React, { useState } from 'react';
import { Button, FlatList, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { collectNodes, setMeasurer } from '../src/inspect';
import { sameFiber, propsOf, type Fiber } from '../src/fiber';
import type { Frame } from '../src/types';

export const SCREEN = { width: 400, height: 800 };

const mounted: ReactTestRenderer[] = [];

export async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  if (!renderer) throw new Error('render failed');
  mounted.push(renderer);
  return renderer;
}

export async function unmountAll(): Promise<void> {
  while (mounted.length > 0) {
    const renderer = mounted.pop();
    if (renderer) {
      await act(async () => {
        renderer.unmount();
      });
    }
  }
}

/** Key a host fiber by its testID, else by its text; used to hand out frames. */
export function keyOf(fiber: Fiber): string | null {
  const testID = propsOf(fiber).testID;
  if (typeof testID === 'string') return testID;
  const node = collectNodes().find((candidate) => sameFiber(candidate.fiber, fiber));
  return node && node.text ? node.text : null;
}

/** Inject frames by testID/text; anything else gets a small on-screen frame. */
export function useFrames(frames: Record<string, Frame | null>, fallback: Frame | null = { x: 0, y: 0, width: 10, height: 10 }): void {
  setMeasurer(async (fiber) => {
    const key = keyOf(fiber);
    if (key !== null && key in frames) return frames[key] ?? null;
    return fallback;
  });
}

export function frame(x: number, y: number, width: number, height: number): Frame {
  return { x, y, width, height };
}

export interface Spies {
  onLogin: jest.Mock;
  onLongLogin: jest.Mock;
  onGo: jest.Mock;
  onDisabled: jest.Mock;
  onSwitch: jest.Mock;
  onSubmit: jest.Mock;
  onUncontrolledChange: jest.Mock;
  onUncontrolledChangeText: jest.Mock;
  onUncontrolledSubmit: jest.Mock;
  onControlledChange: jest.Mock;
  onDelete: jest.Mock;
}

export function makeSpies(): Spies {
  return {
    onLogin: jest.fn(),
    onLongLogin: jest.fn(),
    onGo: jest.fn(),
    onDisabled: jest.fn(),
    onSwitch: jest.fn(),
    onSubmit: jest.fn(),
    onUncontrolledChange: jest.fn(),
    onUncontrolledChangeText: jest.fn(),
    onUncontrolledSubmit: jest.fn(),
    onControlledChange: jest.fn(),
    onDelete: jest.fn(),
  };
}

function Card({ title, testID, children }: { title: string; testID: string; children?: React.ReactNode }) {
  return (
    <View testID={testID}>
      <Text>{title}</Text>
      {children}
    </View>
  );
}

/** A screen touching every feature the inspector understands. */
export function SampleScreen({ spies }: { spies: Spies }) {
  const [name, setName] = useState('');
  const [on, setOn] = useState(false);
  return (
    <ScrollView testID="main-scroll">
      <Text>Welcome back</Text>
      <Card title="Account" testID="account-card">
        <Pressable
          testID="login-button"
          accessibilityLabel="Sign in now"
          onPress={spies.onLogin}
          onLongPress={spies.onLongLogin}
        >
          <Text>Log in</Text>
        </Pressable>
        <Button title="Go" onPress={spies.onGo} />
        <Pressable testID="disabled-button" disabled onPress={spies.onDisabled}>
          <Text>Unavailable</Text>
        </Pressable>
      </Card>
      <TextInput
        testID="name-input"
        placeholder="Your name"
        value={name}
        onChangeText={(text) => {
          spies.onControlledChange(text);
          setName(text);
        }}
        onSubmitEditing={spies.onSubmit}
      />
      <TextInput
        testID="notes-input"
        defaultValue="seed"
        onChange={spies.onUncontrolledChange}
        onChangeText={spies.onUncontrolledChangeText}
        onSubmitEditing={spies.onUncontrolledSubmit}
      />
      <Switch
        testID="notify-switch"
        value={on}
        onValueChange={(next) => {
          spies.onSwitch(next);
          setOn(next);
        }}
      />
      <Text testID="state-line">{`name=${name} on=${String(on)}`}</Text>
      <Pressable testID="delete-1" onPress={() => spies.onDelete(1)}>
        <Text>Delete</Text>
      </Pressable>
      <Pressable testID="delete-2" onPress={() => spies.onDelete(2)}>
        <Text>Delete</Text>
      </Pressable>
      <FlatList
        testID="feed"
        data={['one', 'two']}
        keyExtractor={(item) => item}
        renderItem={({ item }) => <Text>{`item ${item}`}</Text>}
      />
    </ScrollView>
  );
}

export const SAMPLE_FRAMES: Record<string, Frame | null> = {
  'main-scroll': frame(0, 0, 400, 800),
  'Welcome back': frame(16, 20, 200, 24),
  'account-card': frame(0, 50, 400, 260),
  'login-button': frame(24, 60, 352, 48),
  Go: frame(24, 120, 352, 44),
  'disabled-button': frame(24, 170, 352, 44),
  'name-input': frame(24, 230, 352, 40),
  'notes-input': frame(24, 280, 352, 40),
  'notify-switch': frame(24, 330, 60, 32),
  'state-line': frame(24, 370, 352, 20),
  'delete-1': frame(24, 400, 100, 40),
  'delete-2': frame(24, 450, 100, 40),
  feed: frame(0, 500, 400, 300),
  'item one': frame(16, 500, 300, 30),
  'item two': frame(16, 540, 300, 30),
};
